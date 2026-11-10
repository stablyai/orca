import { SessionObservationRetries } from '../ai-vault/session-observation-retries'
import { throwIfAiVaultScanCancelled } from '../ai-vault/ai-vault-scan-cancellation'
import { recordSessionScanIssue, scanIssueTextFromError } from '../ai-vault/session-scan-issues'
import { SessionFileInventory } from '../ai-vault/session-file-inventory'
import type { DiscoverSessionFilesArgs } from '../ai-vault/session-scanner-discovery'
import type { SessionDiscoveryDependency } from '../ai-vault/session-discovery-context'
import type { SessionSearchRootWatch } from './session-search-root-watchers'

/** Losing a subscription invalidates the input observation, not every transcript using that input. */
export class SessionSearchDependencyInventory {
  private readonly inventory: SessionFileInventory | undefined
  private readonly observe: ((force: boolean) => Promise<ReadonlySet<string>>) | undefined
  private readonly retries = new SessionObservationRetries()
  private readonly delivered = new Set<string>()
  private readonly keys = new Map<string, string | Set<string>>()
  constructor(
    readonly dependency: SessionDiscoveryDependency,
    public polling = false
  ) {
    this.inventory =
      dependency.observe || dependency.eventsOnly
        ? undefined
        : new SessionFileInventory(dependency.path)
    this.observe = dependency.observe?.()
  }
  get pending(): boolean {
    return this.retries.pending || (this.inventory?.pending ?? false)
  }
  begin(wake: boolean, args: DiscoverSessionFilesArgs): void {
    this.retries.begin(wake)
    this.retries.report(args.issues)
    this.inventory?.begin(wake, args)
  }
  settleDelivered(): string[] {
    const paths: string[] = []
    for (const key of this.delivered) {
      const owners = [...this.owners(key)]
      if (owners.length) {
        paths.push(...owners)
        this.delivered.delete(key)
      }
    }
    return paths
  }
  discardUnowned(): void {
    this.delivered.clear()
  }
  owners(key: string): Iterable<string> {
    const owners = this.keys.get(key)
    return typeof owners === 'string' ? [owners] : (owners ?? [])
  }
  addFile(path: string): void {
    const key = this.dependency.fileKey?.(path)
    if (!key) {
      return
    }
    const paths = this.keys.get(key)
    if (!paths) {
      this.keys.set(key, path)
    } else if (typeof paths === 'string') {
      if (paths !== path) {
        this.keys.set(key, new Set([paths, path]))
      }
    } else {
      paths.add(path)
    }
  }
  removeFile(path: string): void {
    const key = this.dependency.fileKey?.(path)
    if (!key) {
      return
    }
    const paths = this.keys.get(key)
    if (typeof paths === 'string') {
      if (paths === path) {
        this.keys.delete(key)
      }
    } else if (paths) {
      paths.delete(path)
      if (!paths.size) {
        this.keys.delete(key)
      } else if (paths.size === 1) {
        this.keys.set(key, paths.values().next().value!)
      }
    }
  }
  async changedKeys(
    watch: SessionSearchRootWatch | undefined,
    args: DiscoverSessionFilesArgs,
    overdue: () => boolean
  ): Promise<Set<string>> {
    if (this.dependency.eventsOnly) {
      for (const event of watch?.events.values() ?? []) {
        const key = this.dependency.eventKey?.(event.path)
        if (key) {
          this.delivered.add(key)
        }
      }
      return new Set()
    }
    if (this.observe) {
      const delivered = [...(watch?.events.values() ?? [])].some(
        (event) => !!this.dependency.eventKey?.(event.path)
      )
      if (delivered) {
        this.retries.wake(this.dependency.path)
      }
      if (!this.retries.mayAttempt(this.dependency.path)) {
        return new Set()
      }
      try {
        const keys = new Set(
          await this.observe(delivered || this.retries.force(this.dependency.path))
        )
        this.retries.delete(this.dependency.path)
        return keys
      } catch (error) {
        throwIfAiVaultScanCancelled(args.signal)
        const issue = {
          agent: args.agent,
          path: this.dependency.path,
          ...scanIssueTextFromError(error)
        }
        recordSessionScanIssue(args.issues, issue)
        this.retries.fail(this.dependency.path, delivered, issue)
        return new Set()
      }
    }
    const keys = new Set<string>()
    const inventory = this.inventory!
    if ((!watch || watch.failed || watch.reconcile) && !inventory.walking) {
      inventory.reconcile()
    }
    for (const event of watch?.events.values() ?? []) {
      inventory.invalidate(event.path)
    }
    inventory.retryFailures()
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
    return keys
  }
}
