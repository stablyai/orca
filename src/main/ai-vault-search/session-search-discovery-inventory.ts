import { SessionSearchDependencyInventory } from './session-search-dependency-inventory'
import { SessionSearchRootWatchers } from './session-search-root-watchers'
import { SessionSearchContainerInventory } from './session-search-container-inventory'
import { SessionFileInventory } from '../ai-vault/session-file-inventory'
import type { DiscoverSessionFilesArgs } from '../ai-vault/session-scanner-discovery'
import type { SessionFileCandidate, SessionFileDiscovery } from '../ai-vault/session-scanner-types'
import { sessionSearchPhysicalRoot, type SessionSearchScanRoots } from './session-search-scan-roots'
import type { SessionDiscoveryContext } from '../ai-vault/session-discovery-context'
import type { AiVaultScanIssue } from '../../shared/ai-vault/contracts/ai-vault-types'

type Root = {
  inventory: SessionFileInventory
  args: DiscoverSessionFilesArgs
  identity?: string
  fallback: boolean
  dependencies: Map<string, SessionSearchDependencyInventory>
}

/** Search owns its notifications and raw membership; ordinary History discovery stays stateless. */
export class SessionSearchDiscoveryInventory implements SessionDiscoveryContext {
  private readonly roots = new Map<string, Root>()
  private readonly artifactMaps = new Map<string, Map<string, string>>()
  readonly containers = new SessionSearchContainerInventory()
  private readonly owner = new AbortController()
  private readonly watchers: SessionSearchRootWatchers
  private force = false
  private maintenance = false
  private overdue = () => false
  private recentLimit = 12
  private seen = new Set<string>()
  readonly forced = new Set<string>()
  readonly metadata = new Set<string>()
  readonly removed = new Set<string>()
  readonly removedCandidates = this.containers.removed
  readonly enumeratedContainers = this.containers.proofs

  constructor(entryPath?: string) {
    this.watchers = new SessionSearchRootWatchers(entryPath)
  }

  begin(options: {
    full: boolean
    maintenance?: boolean
    overdue: () => boolean
    recentLimit: number
  }): void {
    this.force = options.full
    this.maintenance = options.maintenance === true
    this.overdue = options.overdue
    this.recentLimit = options.recentLimit
    this.watchers.begin()
    this.seen = new Set()
    this.containers.begin(options.full || this.maintenance, this.recentLimit)
    this.forced.clear()
    this.metadata.clear()
    this.removed.clear()
  }

  get walking(): boolean {
    return [...this.roots.values()].some((root) => root.inventory.walking)
  }

  get pending(): boolean {
    if (this.containers.pending) {
      return true
    }
    for (const root of this.roots.values()) {
      if (
        root.inventory.pending ||
        [...root.dependencies.values()].some((dependency) => dependency.pending)
      ) {
        return true
      }
    }
    return false
  }

  listings(): { root: string; files: number }[] {
    return [...this.roots.values()].map((root) => ({
      root: root.inventory.root,
      files: root.inventory.files.size
    }))
  }

  artifacts(root: string): Map<string, string> {
    let map = this.artifactMaps.get(root)
    if (!map) {
      map = new Map()
      this.artifactMaps.set(root, map)
    }
    return map
  }

  private physicalInventory(
    candidate: SessionFileCandidate,
    logicalRoot: string,
    roots: SessionSearchScanRoots
  ) {
    const {
      agent,
      file: { path }
    } = candidate
    const rootDir = sessionSearchPhysicalRoot(roots, { agent, rootDir: logicalRoot }, path)
    if (rootDir === null) {
      return null
    }
    const root = rootDir === undefined ? undefined : this.roots.get(`${agent}:${rootDir}`)
    if (!root?.inventory.files.has(path)) {
      throw new Error('Session search read has no physical inventory owner')
    }
    return root
  }

  hasPublicationDebt(
    candidate: SessionFileCandidate,
    logicalRoot: string,
    roots: SessionSearchScanRoots
  ): boolean {
    return (
      this.physicalInventory(candidate, logicalRoot, roots)?.inventory.hasPublicationDebt(
        candidate.file.path
      ) ?? false
    )
  }

  async observeForRead(
    candidate: SessionFileCandidate,
    logicalRoot: string,
    roots: SessionSearchScanRoots
  ) {
    const root = this.physicalInventory(candidate, logicalRoot, roots)
    if (!root) {
      return null
    }
    const path = candidate.file.path
    const change = await root.inventory.observeForRead(path, root.args, this.recentLimit)
    if (change) {
      for (const observer of root.dependencies.values()) {
        observer.addFile(path)
      }
    }
    return change
  }

  async files(args: DiscoverSessionFilesArgs): Promise<SessionFileDiscovery> {
    const key = `${args.agent}:${args.rootDir}`
    this.seen.add(key)
    let root = this.roots.get(key)
    if (!root) {
      const fallback = await this.watchers.requiresPolling(args.rootDir)
      root = {
        inventory: new SessionFileInventory(args.rootDir),
        args,
        fallback,
        dependencies: new Map()
      }
      this.roots.set(key, root)
    }
    root.args = args
    root.inventory.begin(this.force || this.maintenance, args)
    let watching = false
    if (this.maintenance) {
      root.fallback = await this.watchers.requiresPolling(args.rootDir)
    }
    if (root.fallback) {
      if (!root.inventory.walking) {
        root.inventory.reconcile()
      }
    } else {
      const watch = await this.watchers.watch(args.rootDir, args.signal)
      if (!watch) {
        if (!root.inventory.walking) {
          root.inventory.reconcile()
        }
      } else {
        watching = !watch.failed
        if (
          (this.force || watch.reconcile || root.identity !== watch.identity) &&
          (root.identity !== undefined || !root.inventory.walking)
        ) {
          root.inventory.reconcile()
        }
        if (
          root.identity !== watch.identity &&
          (await this.watchers.requiresPolling(args.rootDir))
        ) {
          root.fallback = true
        }
        if (watch.failed && !root.inventory.walking) {
          root.inventory.reconcile()
        }
        if (!watch.failed && (watch.reconcile || root.identity !== watch.identity)) {
          root.inventory.wakeFailures()
        }
        root.identity = watch.identity
        for (const event of watch.events.values()) {
          root.inventory.invalidate(event.path)
        }
      }
    }
    const auxiliaries = await Promise.all(
      (args.searchDependencies ?? []).map(async (dependency) => {
        let observer = root.dependencies.get(dependency.path)
        if (!observer) {
          const polling = root.fallback || (await this.watchers.requiresPolling(dependency.path))
          observer = new SessionSearchDependencyInventory(dependency, polling)
          root.dependencies.set(dependency.path, observer)
        } else if (this.maintenance) {
          observer.polling = root.fallback || (await this.watchers.requiresPolling(dependency.path))
        }
        return {
          dependency,
          observer,
          watch: observer.polling
            ? undefined
            : await this.watchers.watch(dependency.path, args.signal, dependency.mode)
        }
      })
    )
    for (const { dependency, observer, watch: auxiliary } of auxiliaries) {
      observer.begin(
        this.force || this.maintenance || !!(auxiliary?.reconcile && !auxiliary.failed),
        args
      )
      const eventKeys = await observer.changedKeys(auxiliary, args, this.overdue)
      for (const key of eventKeys) {
        for (const path of observer.owners(key)) {
          root.inventory.invalidate(path)
          if (dependency.metadata) {
            this.metadata.add(path)
          }
        }
      }
    }
    root.inventory.retryFailures()
    if (root.fallback || !watching) {
      await root.inventory.pollRecent(args, this.recentLimit)
    }
    const delta = await root.inventory.drain(args, this.overdue, this.recentLimit)
    for (const change of delta.changes) {
      if (change.force) {
        this.forced.add(change.file.path)
      }
      for (const observer of root.dependencies.values()) {
        observer.addFile(change.file.path)
      }
    }
    for (const observer of root.dependencies.values()) {
      for (const path of observer.settleDelivered()) {
        root.inventory.invalidate(path)
      }
      if (!root.inventory.walking && !root.inventory.refused) {
        observer.discardUnowned()
      }
    }
    for (const path of delta.removedDirectories) {
      this.artifactMaps.get(args.rootDir)?.delete(path)
    }
    for (const path of delta.removed) {
      for (const observer of root.dependencies.values()) {
        observer.removeFile(path)
      }
      this.removed.add(path)
    }
    return {
      agent: args.agent,
      rootDir: args.rootDir,
      files: delta.changes.map((change) => change.file)
    }
  }

  containerPaths(
    root: string,
    read: (issues: AiVaultScanIssue[]) => Promise<readonly string[]>,
    issues: AiVaultScanIssue[]
  ) {
    return this.containers.containerPaths(root, read, issues)
  }

  container(
    key: string,
    paths: readonly string[],
    read: (paths: readonly string[], limit: number) => Promise<SessionFileDiscovery>,
    _limit: number,
    issues: readonly AiVaultScanIssue[],
    enumerationComplete = true
  ): Promise<SessionFileDiscovery> {
    return this.containers.discover(
      key,
      paths,
      read,
      issues,
      this.owner.signal,
      enumerationComplete
    )
  }

  async end(): Promise<void> {
    await this.watchers.end()
    this.containers.end()
    for (const key of this.roots.keys()) {
      if (!this.seen.has(key)) {
        const root = this.roots.get(key)!
        for (const path of root.inventory.files.keys()) {
          this.removed.add(path)
        }
        this.artifactMaps.delete(root.inventory.root)
        this.roots.delete(key)
      }
    }
  }

  close(): Promise<void> {
    this.owner.abort()
    this.roots.clear()
    this.containers.clear()
    this.artifactMaps.clear()
    return this.watchers.close()
  }
}
