import type { SessionSearchRemovalReceipt } from '../ai-vault-search/session-search-observation-authority'
import { SessionInventoryDirectoryWalks } from './session-file-inventory-walk'
import { dirname } from 'node:path'
import { wslGatedStat } from '../native-chat/wsl-transcript-fs-access'
import { throwIfAiVaultScanCancelled } from './ai-vault-scan-cancellation'
import {
  isMissingTranscriptPathError,
  type DiscoverSessionFilesArgs
} from './session-scanner-discovery'
import { isInsideSessionRoot } from './session-file-discovery'
import type { SessionFileChange } from './session-file-inventory-files'
export type { SessionFileChange } from './session-file-inventory-files'

/** The writer retains queued directories, observations and membership across bounded passes. */
export class SessionFileInventory extends SessionInventoryDirectoryWalks {
  private reconcileAgain = false
  private reconciling = false
  private initialized = false
  private chooseDirty = true
  private args: DiscoverSessionFilesArgs | undefined

  get fileCount(): number {
    return this.observations.count
  }
  async has(path: string): Promise<boolean> {
    return (await this.observations.files.get(path)) !== undefined
  }
  async releasePage(): Promise<boolean> {
    return (await this.request({ kind: 'release-scopes-page', scope: this.scope })).count === 0
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
      this.authority.readySize > 0 ||
      this.garbage.size > 0 ||
      this.observations.delivery.size > 0 ||
      this.walking ||
      this.dirty.size > 0 ||
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
      this.initialized = true
      await this.reconcile()
    }
  }
  async wakeFailures(): Promise<void> {
    await this.failures.wake()
    await this.observations.failures.wake()
  }
  get refused(): boolean {
    return this.failures.size > 0 || this.observations.failures.size > 0
  }
  get walking(): boolean {
    return this.cancellations.size > 0 || this.walks.size > 0 || this.reconcileAgain
  }
  async reconcile(): Promise<void> {
    if (this.reconciling) {
      this.reconcileAgain = true
      return
    }
    this.reconciling = true
    await this.schedule(this.root, true)
  }
  async invalidate(path: string, force = true, wake = true): Promise<void> {
    if (!wake) {
      await this.dirty.set(path, ((await this.dirty.get(path)) ?? false) || force)
      return
    }
    await this.request({
      kind: 'input-invalidate',
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
  hasPublicationDebt(path: string): Promise<boolean> {
    return this.observations.failures.force(path)
  }
  async observeForRead(
    path: string,
    args: DiscoverSessionFilesArgs,
    limit: number,
    metadataOnly = false
  ) {
    const file = await this.observations.observe(
      path,
      args,
      false,
      limit,
      !metadataOnly,
      metadataOnly
    )
    const change = this.observations.changes.get(path)
    this.observations.changes.delete(path)
    const delivery = await this.observations.delivery.get(path)
    return file
      ? {
          file,
          force: change?.force || delivery?.force || false,
          metadata: change?.metadata || delivery?.metadata,
          changed: change !== undefined || !!delivery,
          receipt: delivery ? { path, revision: delivery.revision } : undefined
        }
      : undefined
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
    if (!this.walks.size && !this.cancellations.size) {
      this.reconciling = false
      if (this.reconcileAgain) {
        this.reconcileAgain = false
        await this.reconcile()
      }
    }
    await this.request({ kind: 'authority-cleanup', scope: this.scope })
    const page = await this.observations.delivery.page()
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
  private async drainDirty(args: DiscoverSessionFilesArgs, limit: number): Promise<void> {
    const page = await this.request({ kind: 'dirty-page', scope: this.scope })
    const inputs = page.dirtyInputs ?? []
    await this.observations.observePage(
      inputs.filter(({ path }) => this.accepts(path, args)),
      args,
      limit
    )
    for (const { path } of inputs) {
      if (this.accepts(path, args) || !isInsideSessionRoot(this.root, path)) {
        continue
      }
      const revision = (await this.request({ kind: 'authority-probe', scope: this.scope, path }))
        .observationEpoch!
      try {
        const stat = await wslGatedStat(path, 'scan', args.signal)
        if (
          (await this.request({ kind: 'authority-probe-end', scope: this.scope, path, revision }))
            .invalidProof
        ) {
          continue
        }
        await this.failures.delete(path)
        if (stat.isDirectory()) {
          await ((await this.walks.has(path)) ? this.trailing.put(path, true) : this.schedule(path))
        } else if (await this.directories.get(path)) {
          await this.schedule(dirname(path))
        }
      } catch (error) {
        throwIfAiVaultScanCancelled(args.signal)
        if (
          (await this.request({ kind: 'authority-probe-end', scope: this.scope, path, revision }))
            .invalidProof
        ) {
          continue
        }
        if (isMissingTranscriptPathError(error)) {
          await this.schedule(path, false, true, revision)
          await this.schedule(dirname(path))
        } else {
          await this.issue(path, error, args)
        }
      }
    }
  }
  async retryFailures(): Promise<void> {
    await this.request({
      kind: 'retry-admit',
      scope: this.scope,
      root: this.root,
      generation: this.failures.epoch
    })
  }
}
