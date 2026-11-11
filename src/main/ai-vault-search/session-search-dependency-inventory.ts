import type { SessionSearchRemovalReceipt } from './session-search-observation-authority'
import { sessionSearchRecordPages } from './session-search-catalog-pages'
import {
  SessionSearchCatalogClient,
  type SessionSearchCatalogRequest
} from './session-search-catalog-client'
import { SessionObservationRetries } from '../ai-vault/session-observation-retries'
import { throwIfAiVaultScanCancelled } from '../ai-vault/ai-vault-scan-cancellation'
import { recordSessionScanIssue, scanIssueTextFromError } from '../ai-vault/session-scan-issues'
import { SessionFileInventory } from '../ai-vault/session-file-inventory'
import type { DiscoverSessionFilesArgs } from '../ai-vault/session-scanner-discovery'
import type {
  SessionDiscoveryDependency,
  SessionDiscoveryDependencyObserver
} from '../ai-vault/session-discovery-context'
import type { SessionSearchRootWatch } from './session-search-root-watchers'

/** Losing a subscription invalidates the input observation, not every transcript using that input. */
export class SessionSearchDependencyInventory {
  private readonly inventory: SessionFileInventory | undefined
  private readonly observe: SessionDiscoveryDependencyObserver | undefined
  private readonly retries = new SessionObservationRetries()
  private readonly delivered: SessionSearchCatalogClient<{ after?: string }>
  private staging:
    | { iterator?: AsyncGenerator<string>; keys: string[]; serial: number; done: boolean }
    | undefined
  private stagingSequence = 0
  private inventoryAck: { path: string; revision: number }[] | undefined
  private deliveryAfter: string | undefined
  private discardAfter: string | undefined
  private readonly keys: SessionSearchCatalogClient<string>
  constructor(
    readonly dependency: SessionDiscoveryDependency,
    public polling: boolean,
    private readonly request: SessionSearchCatalogRequest,
    private readonly scope: string
  ) {
    this.keys = new SessionSearchCatalogClient(`${scope}:owners`, request)
    this.delivered = new SessionSearchCatalogClient(`${scope}:delivered`, request)
    this.inventory =
      dependency.observe || dependency.eventsOnly
        ? undefined
        : new SessionFileInventory(dependency.path, request, scope)
    this.observe = dependency.observe?.({ request, scope })
  }
  get pending(): boolean {
    return (
      !!this.staging ||
      !!this.inventoryAck ||
      this.retries.pending ||
      this.delivered.size > 0 ||
      this.observe?.pending === true ||
      (this.inventory?.pending ?? false)
    )
  }
  async release(): Promise<boolean> {
    return (await this.request({ kind: 'release-scopes-page', scope: this.scope })).count === 0
  }
  async begin(wake: boolean, args: DiscoverSessionFilesArgs): Promise<void> {
    this.retries.begin(wake)
    this.retries.report(args.issues)
    await this.inventory?.begin(wake, args)
  }
  async settleDelivered(physical: string, overdue: () => boolean): Promise<void> {
    if (!this.delivered.size && this.deliveryAfter === undefined) {
      return
    }
    do {
      const result = await this.delivered.transition({
        kind: 'dependency-fanout',
        scope: this.scope,
        physical,
        metadata: this.dependency.metadata === true,
        after: this.deliveryAfter
      })
      this.deliveryAfter = result.after
      if (!result.dependencyMore && this.deliveryAfter === undefined) {
        break
      }
    } while (!overdue())
  }
  async discardUnowned(overdue: () => boolean): Promise<void> {
    if (!this.delivered.size) {
      return
    }
    do {
      this.discardAfter = (
        await this.delivered.transition({
          kind: 'dependency-discard',
          scope: this.scope,
          after: this.discardAfter
        })
      ).after
    } while (this.discardAfter !== undefined && !overdue())
  }
  async stageChanges(
    watch: SessionSearchRootWatch | undefined,
    args: DiscoverSessionFilesArgs,
    overdue: () => boolean,
    missing = false
  ): Promise<void> {
    this.staging ??= {
      iterator: this.changedKeys(watch, args, overdue, missing),
      keys: [],
      serial: ++this.stagingSequence,
      done: false
    }
    const pending = this.staging
    while (!pending.done || pending.keys.length) {
      if (
        pending.keys.length &&
        (pending.done || pending.keys.length === 256 || !pending.iterator)
      ) {
        await this.delivered.transition({
          kind: 'dependency-deliver',
          scope: this.scope,
          keys: pending.keys,
          receipt: { consumer: 'native-dependency', revision: pending.serial }
        })
        pending.keys = []
        pending.serial = ++this.stagingSequence
      }
      if (pending.done) {
        break
      }
      pending.iterator ??= this.changedKeys(watch, args, overdue, missing)
      try {
        const next = await pending.iterator.next()
        if (next.done) {
          pending.done = true
        } else {
          pending.keys.push(next.value)
        }
      } catch (error) {
        pending.iterator = undefined
        throw error
      }
    }
    this.staging = undefined
  }

  async addFile(path: string): Promise<void> {
    await this.addFiles([path])
  }
  async addFiles(paths: string[]): Promise<void> {
    await this.keys.putPage(
      paths.flatMap((path) => {
        const key = this.dependency.fileKey?.(path)
        return key ? [this.keys.encode(path, key, { parent: key })] : []
      })
    )
  }
  async removeFiles(
    paths: string[],
    observations?: ReadonlyMap<string, SessionSearchRemovalReceipt>
  ): Promise<void> {
    for (const rows of sessionSearchRecordPages(
      paths.map((path) => ({ path, observation: observations?.get(path) }))
    )) {
      await this.keys.transition({ kind: 'dependency-remove', scope: this.keys.scope, rows })
    }
  }
  async removeFile(path: string): Promise<void> {
    await this.keys.delete(path)
  }
  async *changedKeys(
    watch: SessionSearchRootWatch | undefined,
    args: DiscoverSessionFilesArgs,
    overdue: () => boolean,
    missing = false
  ): AsyncGenerator<string> {
    if (this.inventoryAck) {
      await this.inventory!.acknowledge(this.inventoryAck)
      this.inventoryAck = undefined
    }
    if (this.dependency.eventsOnly) {
      const keys = new Set<string>()
      for (const event of watch?.events.values() ?? []) {
        const key = this.dependency.eventKey?.(event.path)
        if (key) {
          keys.add(key)
        }
      }
      yield* keys
      return
    }
    if (this.observe) {
      const delivered = [...(watch?.events.values() ?? [])].some(
        (event) => !!this.dependency.eventKey?.(event.path)
      )
      if (delivered) {
        this.retries.wake(this.dependency.path)
      }
      if (!this.retries.mayAttempt(this.dependency.path)) {
        return
      }
      try {
        const keys = await this.observe(delivered || this.retries.force(this.dependency.path))
        this.retries.delete(this.dependency.path)
        for await (const key of keys) {
          yield key
          if (overdue()) {
            break
          }
        }
        return
      } catch (error) {
        throwIfAiVaultScanCancelled(args.signal)
        const issue = {
          agent: args.agent,
          path: this.dependency.path,
          ...scanIssueTextFromError(error)
        }
        recordSessionScanIssue(args.issues, issue)
        this.retries.fail(this.dependency.path, delivered, issue)
        return
      }
    }
    const keys = new Set<string>()
    const inventory = this.inventory!
    if (
      (!watch || watch.failed || watch.reconcile) &&
      !inventory.walking &&
      !(missing && !watch && inventory.empty)
    ) {
      await inventory.reconcile(watch?.receipt('reconcile'))
      if (watch) {
        watch.reconcile = false
      }
    }
    for (const event of watch?.events.values() ?? []) {
      await inventory.invalidate(event.path, true, true, watch?.eventReceipt(event.path))
      watch?.acknowledgeEvent(event.path)
    }
    await inventory.retryFailures()
    const delta = await inventory.drain(
      {
        ...args,
        rootDir: this.dependency.path,
        extensions: ['*'],
        filePredicate: (path) => !!this.dependency.eventKey?.(path),
        directoryPredicate: this.dependency.mode === 'shallow' ? () => false : undefined,
        contentDependencyPath: undefined,
        searchDependencies: undefined,
        onDirectoryEntries: undefined
      },
      overdue,
      0
    )
    for (const path of [...delta.changes.map((change) => change.file.path), ...delta.removed]) {
      const key = this.dependency.eventKey?.(path)
      if (key) {
        keys.add(key)
      }
    }
    this.inventoryAck = delta.receipts
    yield* keys
    await inventory.acknowledge(delta.receipts)
    this.inventoryAck = undefined
  }
}
