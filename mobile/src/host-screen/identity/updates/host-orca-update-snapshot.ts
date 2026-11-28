import type { RemoteServerUpdaterSnapshot } from '../../../../../src/shared/remote-runtime/host-catalog/remote-server-update'

/** The version the computer's updater offers, has downloading or has ready, if any. */
export function offeredOrcaVersion(snapshot: RemoteServerUpdaterSnapshot | null): string | null {
  const status = snapshot?.status
  return status?.state === 'available' ||
    status?.state === 'downloading' ||
    status?.state === 'downloaded'
    ? status.version
    : null
}

/** Two reads of the computer's updater that would show the same row. */
export function sameSnapshot(
  a: RemoteServerUpdaterSnapshot | null,
  b: RemoteServerUpdaterSnapshot
): boolean {
  return (
    a !== null &&
    a.appVersion === b.appVersion &&
    a.runtimeId === b.runtimeId &&
    a.support.automatic === b.support.automatic &&
    a.support.installMode === b.support.installMode &&
    a.support.reason === b.support.reason &&
    a.status.state === b.status.state &&
    offeredOrcaVersion(a) === offeredOrcaVersion(b)
  )
}
