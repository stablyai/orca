import { throwIfAiVaultScanCancelled } from '../ai-vault/ai-vault-scan-cancellation'
import { recordSessionScanIssue, scanIssueTextFromError } from '../ai-vault/session-scan-issues'
import { SessionFileInventory } from '../ai-vault/session-file-inventory'
import type { DiscoverSessionFilesArgs } from '../ai-vault/session-scanner-discovery'
import type { SessionDiscoveryDependency } from '../ai-vault/session-discovery-context'
import type { SessionSearchRootWatch } from './session-search-root-watchers'

/** Losing a subscription invalidates the input observation, not every transcript using that input. */
export class SessionSearchDependencyInventory {
  private readonly inventory: SessionFileInventory
  private readonly observe: ((force: boolean) => Promise<ReadonlySet<string>>) | undefined
  private refused = false
  private readonly keys = new Map<string, string | Set<string>>()
  constructor(
    readonly dependency: SessionDiscoveryDependency,
    public polling = false
  ) {
    this.inventory = new SessionFileInventory(dependency.path)
    this.observe = dependency.observe?.()
  }
  get pending(): boolean {
    return this.observe ? this.refused : this.inventory.pending
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
    if (this.observe) {
      try {
        const delivered = [...(watch?.events.values() ?? [])].some(
          (event) => !!this.dependency.eventKey?.(event.path)
        )
        const keys = new Set(await this.observe(delivered))
        this.refused = false
        return keys
      } catch (error) {
        throwIfAiVaultScanCancelled(args.signal)
        recordSessionScanIssue(args.issues, {
          agent: args.agent,
          path: this.dependency.path,
          ...scanIssueTextFromError(error)
        })
        this.refused = true
        return new Set()
      }
    }
    const keys = new Set<string>()
    if ((!watch || watch.failed || watch.reconcile) && !this.inventory.walking) {
      this.inventory.reconcile()
    }
    for (const event of watch?.events.values() ?? []) {
      this.inventory.invalidate(event.path)
    }
    this.inventory.retryFailures()
    const delta = await this.inventory.drain(
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
