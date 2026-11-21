import { ReverseIndexedMap } from '../../../../shared/collections/reverse-indexed-map'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'

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
export class MobileSessionSnapshotsByWorktree extends ReverseIndexedMap<
  string,
  RuntimeMobileSessionTabsSnapshot,
  string
> {
  constructor() {
    // Version-only bumps reuse the tabs array, so the indexed PTYs cannot have changed.
    super(collectSnapshotPtyIds, (previous, next) => previous.tabs === next.tabs)
  }

  // Status-only changes owe one version bump, paid when a client frame is next built.
  private readonly owedVersions = new Set<string>()

  worktreeIdsForPty(ptyId: string): ReadonlySet<string> {
    return this.keysFor(ptyId)
  }

  oweVersion(worktreeId: string): void {
    this.owedVersions.add(worktreeId)
  }

  takeOwedVersion(worktreeId: string): boolean {
    return this.owedVersions.delete(worktreeId)
  }

  override set(key: string, value: RuntimeMobileSessionTabsSnapshot): this {
    const previous = super.get(key)
    if (!previous || value.snapshotVersion > previous.snapshotVersion) {
      this.owedVersions.delete(key)
    }
    return super.set(key, value)
  }

  override delete(key: string): boolean {
    this.owedVersions.delete(key)
    return super.delete(key)
  }

  override clear(): void {
    this.owedVersions.clear()
    super.clear()
  }
}
