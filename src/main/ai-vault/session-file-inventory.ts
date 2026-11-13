import type { SessionSearchInputReceipt } from '../ai-vault-search/session-search-catalog-types'
import type { SessionSearchRemovalReceipt } from '../ai-vault-search/session-search-observation-authority'
import { SessionInventoryDirtyInputs } from './session-file-inventory-dirty'
import { throwIfAiVaultScanCancelled } from './scan-lifecycle/ai-vault-scan-cancellation'
import type { DiscoverSessionFilesArgs } from './discovery/session-scanner-discovery'
import type { SessionFileChange } from './session-file-inventory-files'
export type { SessionFileChange } from './session-file-inventory-files'

/** The writer retains queued directories, observations and membership across bounded passes. */
export class SessionFileInventory extends SessionInventoryDirtyInputs {
  private wakeSequence = 0
  private waking: SessionSearchInputReceipt | undefined
  private reconcileAgain = false
  private reconciling = false
  private initialized = false
  private chooseDirty = true
  private args: DiscoverSessionFilesArgs | undefined

  get fileCount(): number {
    return this.observations.count
  }
  get empty(): boolean {
    return this.initialized && !this.pending && !this.refused && !this.hasMembership
  }
  async releasePage(): Promise<boolean> {
    if ((await this.request({ kind: 'release-scopes-page', scope: this.scope })).count !== 0) {
      return false
    }
    this.resetAfterRelease()
    return true
  }
  async reactivate(): Promise<void> {
    await this.completeReactivation()
    this.resetAfterRelease()
  }
  private resetAfterRelease(): void {
    this.initialized = false
    this.reconciling = false
    this.reconcileAgain = false
    this.waking = undefined
    this.releaseProbe()
    this.observations.released()
    this.removedDirectories.clear()
  }
  async removePage(): Promise<string[]> {
    const page = await this.observations.files.page()
    const paths = page.rows.map(({ key }) => key)
    return paths
  }
  async retirePage(paths: string[]): Promise<void> {
    await this.request({ kind: 'forget-files', scope: this.scope, paths, notify: false })
  }
  async *paths(): AsyncGenerator<string> {
    let after: string | undefined
    do {
      const page = await this.observations.files.page({ after })
      for (const { key } of page.rows) {
        yield key
      }
      after = page.after
    } while (after !== undefined)
  }
  get pending(): boolean {
    return (
      this.dirtyProbing ||
      this.observations.applying ||
      this.authority.readySize > 0 ||
      this.garbage.size > 0 ||
      this.observations.delivery.size > 0 ||
      this.walking ||
      this.dirty.size > 0 ||
      this.primaryWakes.size > 0 ||
      this.failures.pending ||
      this.observations.failures.pending
    )
  }
  async begin(wake: boolean, args: DiscoverSessionFilesArgs): Promise<void> {
    this.args = args
    if (!this.initialized) {
      await this.request({ kind: 'authority-open', scope: this.scope, root: this.root })
    }
    await this.failures.begin(wake)
    await this.observations.failures.begin(wake)
    await this.failures.report(args.issues)
    await this.observations.failures.report(args.issues)
    if (!this.initialized) {
      await this.reconcile()
      this.initialized = true
    }
  }
  async wakeFailures(receipt?: SessionSearchInputReceipt): Promise<void> {
    const acceptedReceipt =
      receipt ?? (this.waking ??= { consumer: 'explicit-recovery', revision: ++this.wakeSequence })
    await this.request({
      kind: 'retry-wake',
      scope: this.scope,
      prefix: this.root,
      all: true,
      receipt: acceptedReceipt
    })
    if (!receipt) {
      this.waking = undefined
    }
  }
  get refused(): boolean {
    return this.failures.size > 0 || this.observations.failures.size > 0
  }
  get seedDelivered(): boolean {
    return !this.observations.delivery.size && !this.observations.applying
  }
  get primarySeedWaiting(): boolean {
    return this.primaryWakes.size > 0 && !this.cancellations.size && !this.walks.size
  }
  get walking(): boolean {
    return (
      this.cancellations.size > 0 ||
      this.walks.size > 0 ||
      this.reconcileAgain ||
      this.primarySeedWaiting
    )
  }
  async reconcile(receipt?: SessionSearchInputReceipt): Promise<void> {
    if (this.primarySeedWaiting) {
      this.reconcileAgain = true
      return
    }
    if (receipt) {
      await this.request({
        kind: 'directory-schedule',
        scope: this.scope,
        path: this.root,
        depth: 0,
        reconcile: true,
        trailing: true,
        receipt
      })
      this.reconciling = true
      return
    }
    if (this.reconciling) {
      this.reconcileAgain = true
      return
    }
    await this.schedule(this.root, true)
    this.reconciling = true
  }
  async invalidate(
    path: string,
    force = true,
    wake = true,
    receipt?: SessionSearchInputReceipt
  ): Promise<void> {
    if (!wake) {
      await this.dirty.set(path, ((await this.dirty.get(path)) ?? false) || force)
      return
    }
    await this.request({
      kind: 'input-invalidate',
      receipt,
      scope: this.scope,
      path,
      force,
      subtree: this.args ? !this.accepts(path, this.args) : true
    })
  }
  async pollRecent(args: DiscoverSessionFilesArgs, limit: number): Promise<void> {
    // eslint-disable-next-line unicorn/no-useless-spread -- Observing a file refreshes this bounded map's iteration order.
    for (const path of [...this.observations.recent.keys()]) {
      if (!(await this.dirty.has(path))) {
        await this.observations.observe(path, args, false, limit)
      }
    }
  }
  async drain(
    args: DiscoverSessionFilesArgs,
    overdue: () => boolean,
    recentLimit: number
  ): Promise<{
    changes: SessionFileChange[]
    removed: string[]
    removedDirectories: string[]
    removalReceipts: ReadonlyMap<string, SessionSearchRemovalReceipt>
    receipts: { path: string; revision: number }[]
  }> {
    if (!this.initialized) {
      await this.begin(false, args)
    }
    await this.observations.resume(recentLimit)
    let consumed = 0
    while (
      (this.cancellations.size ||
        this.dirty.size ||
        this.walks.size ||
        this.authority.readySize ||
        this.garbage.size) &&
      (consumed === 0 || !overdue()) &&
      this.observations.changes.size +
        this.observations.removed.size +
        this.removedDirectories.size <
        256
    ) {
      consumed++
      throwIfAiVaultScanCancelled(args.signal)
      if (this.cancellations.size) {
        await this.request({ kind: 'directory-cancel-step', scope: this.scope })
      } else if (this.dirty.size && (!this.walks.size || this.chooseDirty)) {
        this.chooseDirty = false
        await this.drainDirty(args, recentLimit)
      } else if (this.walks.size) {
        this.chooseDirty = true
        const entry = await this.walks.firstEntry()
        if (entry) {
          await this.drainWalk(entry[1], args, recentLimit)
        }
      } else {
        await this.request({ kind: 'authority-cleanup', scope: this.scope })
      }
    }
    if (!this.walks.size && !this.cancellations.size && !this.primaryWakes.size) {
      this.reconciling = false
      if (this.reconcileAgain) {
        this.reconcileAgain = false
        await this.reconcile()
      }
    }
    if (this.authority.readySize || this.garbage.size) {
      await this.request({ kind: 'authority-cleanup', scope: this.scope })
    }
    const page = this.observations.delivery.size
      ? await this.observations.delivery.page()
      : { rows: [] }
    const result = {
      changes: page.rows.flatMap(({ value }) =>
        value.file
          ? [
              {
                file: { ...value.file, modifiedAt: new Date(value.file.mtimeMs).toISOString() },
                force: value.force,
                metadata: value.metadata
              }
            ]
          : []
      ),
      removed: page.rows.filter(({ value }) => value.removed).map(({ key }) => key),
      removalReceipts: new Map(
        page.rows
          .filter(({ value }) => value.removed)
          .map(({ key, value }) => [
            key,
            { scope: this.scope, revision: value.revision, authority: value.authority! }
          ])
      ),
      receipts: page.rows.map(({ key, value }) => ({ path: key, revision: value.revision })),
      removedDirectories: [...this.removedDirectories]
    }
    this.observations.changes.clear()
    this.observations.removed.clear()
    this.removedDirectories.clear()
    return result
  }
  acknowledge(receipts: { path: string; revision: number }[]): Promise<void> {
    return this.observations.acknowledge(receipts)
  }
  async retryFailures(primary = true): Promise<void> {
    if (
      (primary && this.primaryWakes.size) ||
      this.failures.pending ||
      this.observations.failures.pending
    ) {
      await this.request({
        kind: 'retry-admit',
        primary,
        scope: this.scope,
        root: this.root,
        generation: this.failures.epoch
      })
    }
    if (!this.primaryWakes.size && !this.walks.size && !this.cancellations.size) {
      this.reconciling = false
      if (this.reconcileAgain) {
        this.reconcileAgain = false
        await this.reconcile()
      }
    }
  }
}
