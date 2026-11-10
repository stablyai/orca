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
  private readonly delivered: SessionSearchCatalogClient<true>
  private deliveredCount = 0
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
      this.retries.pending || this.observe?.pending === true || (this.inventory?.pending ?? false)
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
  async *settleDelivered(): AsyncGenerator<string> {
    let after: string | undefined
    do {
      const page = await this.delivered.page({ after })
      for (const { key } of page.rows) {
        let owned = false
        for await (const owner of this.owners(key)) {
          yield owner
          owned = true
        }
        if (owned) {
          await this.delivered.delete(key)
          this.deliveredCount--
        }
      }
      after = page.after
    } while (after !== undefined)
  }
  async discardUnowned(): Promise<void> {
    if (this.deliveredCount) {
      await this.delivered.release()
      this.deliveredCount = 0
    }
  }
  async *owners(key: string): AsyncGenerator<string> {
    let after: string | undefined
    do {
      const page = await this.keys.page({ parent: key, after })
      for (const { key: path } of page.rows) {
        yield path
      }
      after = page.after
    } while (after !== undefined)
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
  async removeFiles(paths: string[]): Promise<void> {
    await this.keys.deletePage(paths)
  }
  async removeFile(path: string): Promise<void> {
    await this.keys.delete(path)
  }
  async *changedKeys(
    watch: SessionSearchRootWatch | undefined,
    args: DiscoverSessionFilesArgs,
    overdue: () => boolean
  ): AsyncGenerator<string> {
    if (this.dependency.eventsOnly) {
      for (const event of watch?.events.values() ?? []) {
        const key = this.dependency.eventKey?.(event.path)
        if (key) {
          if (!(await this.delivered.get(key))) {
            await this.delivered.put(key, true)
            this.deliveredCount++
          }
        }
      }
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
    if ((!watch || watch.failed || watch.reconcile) && !inventory.walking) {
      await inventory.reconcile()
    }
    for (const event of watch?.events.values() ?? []) {
      await inventory.invalidate(event.path)
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
    yield* keys
    await inventory.acknowledge(delta.receipts)
  }
}
