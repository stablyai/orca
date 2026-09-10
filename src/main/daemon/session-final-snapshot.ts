// Teardown checkpoint for a session's held startup bytes.
//
// Split out of `session.ts` because that module sits at the 300-line budget and
// the max-lines ratchet requires new growth to move into a sibling rather than
// take a bypass.

type HeldByteSource = { releaseHeldBytes: () => string }
type SnapshotBarrier = { snapshotBarrier: () => void }
type PendingFlush = { flushPending: () => void }

export function prepareSessionFinalSnapshot(
  shellReady: HeldByteSource,
  startupIngress: SnapshotBarrier,
  recoveryBarrier: PendingFlush
): string {
  const held = shellReady.releaseHeldBytes()
  startupIngress.snapshotBarrier()
  // Why last: snapshotBarrier can emit held spans into the barrier, and a
  // teardown checkpoint mid-episode must not lose the barrier's queued bytes.
  recoveryBarrier.flushPending()
  return held
}
