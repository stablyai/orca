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

  worktreeIdsForPty(ptyId: string): ReadonlySet<string> {
    return this.keysFor(ptyId)
  }
}
