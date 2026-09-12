import type { RuntimeMobileSessionTabsSnapshot as Snapshot } from '../../shared/runtime-types'
import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import { retireTerminalSurfacesFromSnapshot } from './mobile-session-terminal-retirement'
import { mobileSnapshotPtyIds } from './outgoing-mobile-snapshot-admission'

export function prepareOutgoingMobileSnapshotRemoval(
  ptyIds: readonly string[],
  read: () => ReadonlyMap<string, Snapshot>
) {
  const ids = new Set(ptyIds)
  const containsSource = (snapshot: Snapshot) =>
    [...mobileSnapshotPtyIds(snapshot)].some((id) => ids.has(id))
  const entries = new Map(
    [...read()]
      .filter(([, snapshot]) => containsSource(snapshot))
      .map(([key, snapshot]) => {
        if (key !== snapshot.worktree) {
          throw new Error('orcad_outgoing_source_mobile_workspace_mismatch')
        }
        let next = structuredClone(snapshot)
        for (const id of ids) {
          next = retireTerminalSurfacesFromSnapshot({ snapshot: next, ptyId: id })?.snapshot ?? next
        }
        if (containsSource(next)) {
          throw new Error('orcad_outgoing_source_mobile_cleanup_incomplete')
        }
        return [
          key,
          {
            expected: snapshot,
            signature: serializeOrcadMigrationValue(snapshot),
            next,
            applied: false
          }
        ]
      })
  )
  const assertCurrent = () => {
    const current = read()
    for (const [key, entry] of entries) {
      if (
        current.get(key) !== entry.expected ||
        serializeOrcadMigrationValue(entry.expected) !== entry.signature
      ) {
        throw new Error('orcad_outgoing_source_mobile_snapshot_changed')
      }
    }
    for (const [key, snapshot] of current) {
      if (containsSource(snapshot) && (!entries.has(key) || entries.get(key)!.applied)) {
        throw new Error('orcad_outgoing_source_mobile_snapshot_changed')
      }
    }
  }
  return {
    assertCurrent,
    appliedWorktreeIds: () => [...entries].filter(([, entry]) => entry.applied).map(([id]) => id),
    apply(replace: (expected: Snapshot, next: Snapshot) => Snapshot) {
      assertCurrent()
      for (const entry of entries.values()) {
        if (entry.applied) {
          continue
        }
        assertCurrent()
        const saved = replace(entry.expected, structuredClone(entry.next))
        entry.expected = saved
        entry.signature = serializeOrcadMigrationValue(saved)
        entry.applied = true
      }
      assertCurrent()
    }
  }
}
