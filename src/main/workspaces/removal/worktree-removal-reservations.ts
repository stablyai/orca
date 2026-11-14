import type { WorktreeRemovalRecord } from './worktree-removal-records'

const NO_REMOVALS: ReadonlyMap<string, WorktreeRemovalRecord> = new Map()

/** Repo snapshots change only with their reservations, never with unrelated metadata joins. */
export class WorktreeRemovalReservations extends Map<string, WorktreeRemovalRecord> {
  private readonly byRepo = new Map<string, Map<string, WorktreeRemovalRecord>>()
  private readonly snapshots = new Map<string, ReadonlyMap<string, WorktreeRemovalRecord>>()

  override set(id: string, record: WorktreeRemovalRecord): this {
    const previous = this.get(id)
    if (previous === record) {
      return this
    }
    if (previous) {
      this.removeRepoRecord(id, previous.repoId)
    }
    super.set(id, record)
    let records = this.byRepo.get(record.repoId)
    if (!records) {
      records = new Map()
      this.byRepo.set(record.repoId, records)
    }
    records.set(id, record)
    this.snapshots.delete(record.repoId)
    return this
  }

  override delete(id: string): boolean {
    const previous = this.get(id)
    if (!previous) {
      return false
    }
    this.removeRepoRecord(id, previous.repoId)
    return super.delete(id)
  }

  override clear(): void {
    super.clear()
    this.byRepo.clear()
    this.snapshots.clear()
  }

  snapshotForRepo(repoId: string): ReadonlyMap<string, WorktreeRemovalRecord> {
    const records = this.byRepo.get(repoId)
    if (!records) {
      return NO_REMOVALS
    }
    let snapshot = this.snapshots.get(repoId)
    if (!snapshot) {
      snapshot = new Map(records)
      this.snapshots.set(repoId, snapshot)
    }
    return snapshot
  }

  private removeRepoRecord(id: string, repoId: string): void {
    const records = this.byRepo.get(repoId)
    records?.delete(id)
    if (records?.size === 0) {
      this.byRepo.delete(repoId)
    }
    this.snapshots.delete(repoId)
  }
}
