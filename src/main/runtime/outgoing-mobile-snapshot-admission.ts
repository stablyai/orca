import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import { isOutgoingPtyRegistrationFenced } from './outgoing-pty-registration-fence'

export function assertOutgoingMobileSnapshotPublicationAllowed(
  runtime: object,
  snapshots: Iterable<RuntimeMobileSessionTabsSnapshot>
): void {
  if (isOutgoingMobileSnapshotPublicationFenced(runtime, snapshots)) {
    throw new Error('orcad_outgoing_source_mobile_snapshot_fenced')
  }
}

export function isOutgoingMobileSnapshotPublicationFenced(
  runtime: object,
  snapshots: Iterable<RuntimeMobileSessionTabsSnapshot>
): boolean {
  for (const snapshot of snapshots) {
    for (const id of mobileSnapshotPtyIds(snapshot)) {
      if (isOutgoingPtyRegistrationFenced(runtime, id)) {
        return true
      }
    }
  }
  return false
}

export function* mobileSnapshotPtyIds(snapshot: RuntimeMobileSessionTabsSnapshot) {
  for (const tab of snapshot.tabs) {
    if (tab.type !== 'terminal') {
      continue
    }
    if (tab.ptyId) {
      yield tab.ptyId
    }
    yield* Object.values(tab.parentLayout?.ptyIdsByLeafId ?? {})
  }
}
