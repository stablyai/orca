import { SessionSearchDiscoverySources } from './session-search-discovery-sources'
import { SessionSearchDependencyInventory } from './session-search-dependency-inventory'
import { SessionFileInventory } from '../ai-vault/session-file-inventory'
import type { DiscoverSessionFilesArgs } from '../ai-vault/session-scanner-discovery'
import type { SessionFileDiscovery } from '../ai-vault/session-scanner-types'
import type { SessionDiscoveryContext } from '../ai-vault/session-discovery-context'
import type { AiVaultScanIssue } from '../../shared/ai-vault/contracts/ai-vault-types'

/** Search consumes only bounded deltas; the writer retains source membership and unfinished work. */
export class SessionSearchDiscoveryInventory
  extends SessionSearchDiscoverySources
  implements SessionDiscoveryContext
{
  files(args: DiscoverSessionFilesArgs): Promise<SessionFileDiscovery> {
    return this.track(this.discoverFiles(args))
  }
  private async discoverFiles(args: DiscoverSessionFilesArgs): Promise<SessionFileDiscovery> {
    const key = `${args.agent}:${args.rootDir}`
    this.seen.add(key)
    let root = this.roots.get(key)
    if (!root) {
      const fallback = await this.watchers.requiresPolling(args.rootDir)
      root = {
        inventory: new SessionFileInventory(args.rootDir, this.request!, `physical:${key}`),
        args,
        fallback,
        dependencies: new Map()
      }
      this.roots.set(key, root)
    }
    root.retiring = false
    root.args = args
    await root.inventory.begin(this.force || this.maintenance, args)
    const wake = this.primaryWake !== undefined && root.wake !== this.primaryWake
    if (wake) {
      if (!root.inventory.empty) {
        await root.inventory.wakeFailures()
      }
      root.wake = this.primaryWake
    }
    const admitPrimary = async () => {
      if (
        root.inventory.primarySeedWaiting &&
        root.inventory.seedDelivered &&
        (!this.admitSeed || (await this.admitSeed(args.rootDir, args.agent)))
      ) {
        await root.inventory.retryFailures()
        return true
      }
      return false
    }
    await admitPrimary()
    let watching = false
    if (this.maintenance) {
      root.fallback = await this.watchers.requiresPolling(args.rootDir)
    }
    if (root.fallback) {
      if (!root.inventory.walking) {
        await root.inventory.reconcile()
      }
    } else {
      const watch = await this.watchers.watch(
        args.rootDir,
        args.signal,
        'recursive',
        root.inventory.scope
      )
      if (!watch) {
        root.unwatched = true
        if (
          !root.inventory.walking &&
          !(this.watchers.isMissing(args.rootDir) && root.inventory.empty)
        ) {
          await root.inventory.reconcile()
        }
      } else {
        watching = !watch.failed
        if (
          (this.force || watch.reconcile || root.identity !== watch.identity) &&
          (root.identity !== undefined || !root.inventory.walking)
        ) {
          await root.inventory.reconcile(watch.receipt('reconcile'))
          watch.reconcile = false
        }
        if (
          root.identity !== watch.identity &&
          (await this.watchers.requiresPolling(args.rootDir))
        ) {
          root.fallback = true
        }
        if (watch.failed && !root.inventory.walking) {
          await root.inventory.reconcile()
        }
        if (
          !watch.failed &&
          !wake &&
          (watch.recovery ||
            root.unwatched ||
            (root.identity !== undefined && root.identity !== watch.identity))
        ) {
          await root.inventory.wakeFailures(watch.receipt('recovery'))
          watch.recovery = false
        }
        root.unwatched = watch.failed
        root.identity = watch.identity
        for (const event of watch.events.values()) {
          await root.inventory.invalidate(event.path, true, true, watch.eventReceipt(event.path))
          watch.acknowledgeEvent(event.path)
        }
        watch.acknowledge()
      }
    }
    const auxiliaries = await Promise.all(
      (args.searchDependencies ?? []).map(async (dependency) => {
        let observer = root.dependencies.get(dependency.path)
        if (!observer) {
          const polling = root.fallback || (await this.watchers.requiresPolling(dependency.path))
          observer = new SessionSearchDependencyInventory(
            dependency,
            polling,
            root.inventory.catalogRequest,
            `dependency:${key}:${dependency.path}`
          )
          root.dependencies.set(dependency.path, observer)
        } else if (this.maintenance) {
          observer.polling = root.fallback || (await this.watchers.requiresPolling(dependency.path))
        }
        return {
          dependency,
          observer,
          watch: observer.polling
            ? undefined
            : await this.watchers.watch(
                dependency.path,
                args.signal,
                dependency.mode,
                `dependency:${key}:${dependency.path}`
              )
        }
      })
    )
    for (const { observer, watch: auxiliary } of auxiliaries) {
      await observer.begin(
        this.force || this.maintenance || !!(auxiliary?.reconcile && !auxiliary.failed),
        args
      )
      await observer.stageChanges(
        auxiliary,
        args,
        this.overdue,
        this.watchers.isMissing(observer.dependency.path, observer.dependency.mode)
      )
      auxiliary?.acknowledge()
      await observer.settleDelivered(root.inventory.scope, this.overdue)
    }
    await root.inventory.retryFailures(false)
    if (root.fallback || !watching) {
      await root.inventory.pollRecent(args, this.recentLimit)
    }
    do {
      const delta = await root.inventory.drain(args, this.overdue, this.recentLimit)
      const forced = new Set<string>()
      const metadata = new Set<string>()
      const paths = delta.changes.map((change) => change.file.path)
      const changedPaths = new Set(paths)
      const receipts = new Map(delta.receipts.map((receipt) => [receipt.path, receipt]))
      const metadataFacts = await this.metadataDebt!.getPage(paths)
      for (const change of delta.changes) {
        if (change.force) {
          forced.add(change.file.path)
        }
        if (change.metadata || metadataFacts.has(change.file.path)) {
          metadata.add(change.file.path)
        }
      }
      if (!this.accept || !delta.changes.length) {
        for (const observer of root.dependencies.values()) {
          await observer.addFiles(paths)
        }
        await this.settleDependencies(root)
      }
      for (const observer of root.dependencies.values()) {
        await observer.removeFiles(delta.removed, delta.removalReceipts)
      }
      for (const path of delta.removed) {
        if (!this.acceptRemoved) {
          this.removed.add(path)
        }
      }
      await this.acceptRemoved?.(delta.removed, delta.removalReceipts)
      if (this.accept && delta.changes.length) {
        const transferred = await this.accept(
          {
            agent: args.agent,
            rootDir: args.rootDir,
            files: delta.changes.map((change) => change.file)
          },
          forced,
          metadata,
          new Map(
            delta.changes.map(({ file }) => {
              const receipt = receipts.get(file.path)!
              return [
                file.path,
                this.discoveryInput(root, file.path, receipt.revision, metadataFacts.get(file.path))
              ]
            })
          )
        )
        if (!transferred) {
          for (const observer of root.dependencies.values()) {
            await observer.addFiles(paths)
          }
          await this.settleDependencies(root)
          await this.metadataDebt!.transition({
            kind: 'ack-values',
            scope: this.metadataDebt!.scope,
            rows: [...metadataFacts].map(([key, value]) => ({ key, value: JSON.stringify(value) }))
          })
        } else {
          await this.settleDependencies(root)
          await root.inventory.acknowledge(
            delta.receipts.filter((receipt) => !changedPaths.has(receipt.path))
          )
          const admittedPrimary = await admitPrimary()
          if (
            (!delta.changes.length && !delta.removed.length && !admittedPrimary) ||
            this.overdue()
          ) {
            break
          }
          continue
        }
      } else if (!this.accept) {
        await root.inventory.acknowledge(delta.receipts)
        return {
          agent: args.agent,
          rootDir: args.rootDir,
          files: delta.changes.map((change) => change.file)
        }
      }
      await root.inventory.acknowledge(delta.receipts)
      const admittedPrimary = await admitPrimary()
      if ((!delta.changes.length && !delta.removed.length && !admittedPrimary) || this.overdue()) {
        break
      }
    } while (root.inventory.pending)
    return { agent: args.agent, rootDir: args.rootDir, files: [] }
  }

  containerPaths(
    root: string,
    read: (issues: AiVaultScanIssue[]) => Promise<readonly string[]>,
    issues: AiVaultScanIssue[]
  ) {
    return this.track(this.containers.containerPaths(root, read, issues))
  }

  container(
    key: string,
    paths: readonly string[],
    read: (paths: readonly string[], limit: number) => Promise<SessionFileDiscovery>,
    limit: number,
    issues: readonly AiVaultScanIssue[],
    enumerationComplete = true
  ): Promise<SessionFileDiscovery> {
    return this.track(this.discoverContainer(key, paths, read, limit, issues, enumerationComplete))
  }
  private async discoverContainer(
    key: string,
    paths: readonly string[],
    read: (paths: readonly string[], limit: number) => Promise<SessionFileDiscovery>,
    _limit: number,
    issues: readonly AiVaultScanIssue[],
    enumerationComplete = true
  ): Promise<SessionFileDiscovery> {
    const discovery = await this.containers.discover(
      key,
      paths,
      read,
      issues,
      this.owner.signal,
      enumerationComplete
    )
    if (!this.accept) {
      await this.containers.acknowledge(discovery)
      return discovery
    }
    await this.accept(discovery)
    await this.containers.acknowledge(discovery)
    while (this.containers.hasChanges(key) && !this.overdue()) {
      const next = await this.containers.drain(key)
      if (!next?.files.length) {
        break
      }
      await this.accept(next)
      await this.containers.acknowledge(next)
    }
    return { ...discovery, files: [] }
  }
}
