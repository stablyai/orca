import type { RuntimeMobileSessionTabsSnapshot } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'

const NO_WORKTREES: ReadonlySet<string> = new Set()

function collectSnapshotPtyIds(snapshot: RuntimeMobileSessionTabsSnapshot): Set<string> {
  const ptyIds = new Set<string>()
  for (const tab of snapshot.tabs) {
    if (tab.type !== 'terminal') {
      continue
    }
    if (typeof tab.ptyId === 'string') {
      ptyIds.add(tab.ptyId)
    }
    const layoutPtyId = tab.parentLayout?.ptyIdsByLeafId?.[tab.leafId]
    if (typeof layoutPtyId === 'string') {
      ptyIds.add(layoutPtyId)
    }
  }
  return ptyIds
}

/** Indexes PTYs inside the map's own writes so PTY title/output fanout never scans the fleet. */
export class MobileSessionSnapshotsByWorktree extends Map<
  string,
  RuntimeMobileSessionTabsSnapshot
> {
  private readonly ptyIdsByWorktree = new Map<string, Set<string>>()
  private readonly worktreeIdsByPtyId = new Map<string, Set<string>>()

  worktreeIdsForPty(ptyId: string): ReadonlySet<string> {
    return this.worktreeIdsByPtyId.get(ptyId) ?? NO_WORKTREES
  }

  override set(worktreeId: string, snapshot: RuntimeMobileSessionTabsSnapshot): this {
    // Version-only bumps reuse the tabs array, so the indexed PTYs cannot have changed.
    if (super.get(worktreeId)?.tabs !== snapshot.tabs) {
      this.reindex(worktreeId, collectSnapshotPtyIds(snapshot))
    }
    return super.set(worktreeId, snapshot)
  }

  override delete(worktreeId: string): boolean {
    this.reindex(worktreeId, null)
    return super.delete(worktreeId)
  }

  override clear(): void {
    this.ptyIdsByWorktree.clear()
    this.worktreeIdsByPtyId.clear()
    super.clear()
  }

  private reindex(worktreeId: string, next: Set<string> | null): void {
    const previous = this.ptyIdsByWorktree.get(worktreeId)
    for (const ptyId of previous ?? []) {
      if (next?.has(ptyId)) {
        continue
      }
      const worktreeIds = this.worktreeIdsByPtyId.get(ptyId)
      worktreeIds?.delete(worktreeId)
      if (worktreeIds?.size === 0) {
        this.worktreeIdsByPtyId.delete(ptyId)
      }
    }
    for (const ptyId of next ?? []) {
      if (previous?.has(ptyId)) {
        continue
      }
      let worktreeIds = this.worktreeIdsByPtyId.get(ptyId)
      if (!worktreeIds) {
        worktreeIds = new Set()
        this.worktreeIdsByPtyId.set(ptyId, worktreeIds)
      }
      worktreeIds.add(worktreeId)
    }
    if (next && next.size > 0) {
      this.ptyIdsByWorktree.set(worktreeId, next)
    } else {
      this.ptyIdsByWorktree.delete(worktreeId)
    }
  }
}
