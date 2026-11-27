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

/** Throws when the active call may not make this write to the workspace's host list. */
export type WriteAdmission = (
  worktreeId: string,
  previous: RuntimeMobileSessionTabsSnapshot | undefined,
  next: RuntimeMobileSessionTabsSnapshot | undefined
) => void

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
  // A fresh mark per owe stands in for the stored object, so queued frames see the newer status as a change.
  private readonly deliveryMarks = new Map<string, number>()
  private deliveryMarkSequence = 0
  private payingWorktreeId: string | null = null
  // The one write point of the host's lists: who may write a workspace's list is decided here.
  private admitWrite: WriteAdmission = () => {}

  /** Installed once by the runtime (teammate-rules.ts, rule 4). */
  admitWritesBy(admit: WriteAdmission): void {
    this.admitWrite = admit
  }

  worktreeIdsForPty(ptyId: string): ReadonlySet<string> {
    return this.keysFor(ptyId)
  }

  oweVersion(worktreeId: string): void {
    this.owedVersions.add(worktreeId)
    this.deliveryMarks.set(worktreeId, ++this.deliveryMarkSequence)
  }

  /** Runs pay only when a bump is owed; paying only catches the version up, so it keeps the delivery mark. */
  payOwedVersion<T>(worktreeId: string, pay: () => T): T | undefined {
    if (!this.owedVersions.delete(worktreeId)) {
      return undefined
    }
    this.payingWorktreeId = worktreeId
    try {
      return pay()
    } finally {
      this.payingWorktreeId = null
    }
  }

  /** Changes exactly when the stored snapshot or its owed status changes, so queued frames can tell they are stale. */
  deliverySource(worktreeId: string): unknown {
    return this.deliveryMarks.get(worktreeId) ?? this.get(worktreeId)
  }

  override set(key: string, value: RuntimeMobileSessionTabsSnapshot): this {
    const previous = super.get(key)
    this.admitWrite(key, previous, value)
    if (this.payingWorktreeId !== key) {
      this.deliveryMarks.delete(key)
      if (!previous || value.snapshotVersion > previous.snapshotVersion) {
        this.owedVersions.delete(key)
      }
    }
    return super.set(key, value)
  }

  override delete(key: string): boolean {
    this.admitWrite(key, super.get(key), undefined)
    this.owedVersions.delete(key)
    this.deliveryMarks.delete(key)
    return super.delete(key)
  }

  override clear(): void {
    for (const [key, previous] of this) {
      this.admitWrite(key, previous, undefined)
    }
    this.owedVersions.clear()
    this.deliveryMarks.clear()
    super.clear()
  }
}
