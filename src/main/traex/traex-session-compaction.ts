import type { TraexSession } from './traex-session'
import { traexNonnegativeNumber, traexTimestampMs } from './traex-protocol'

/** Finish the host's compaction command turn with the provider's own timing. */
export function finishTraexCompaction(
  session: TraexSession,
  failed = false,
  turn?: Record<string, unknown>
): void {
  session.timeline?.apply(
    {
      type: 'turn.end',
      at: traexTimestampMs(turn?.completedAt) ?? Date.now(),
      durationMs: traexNonnegativeNumber(turn?.durationMs),
      state: turn?.status === 'interrupted' ? 'interrupted' : 'completed',
      outcome: failed ? 'failure' : turn?.status === 'interrupted' ? undefined : 'success',
      ...(session.activeTurn ? { providerTurnId: session.activeTurn } : {})
    },
    () => {
      session.compacting = false
      session.activeTurn = null
    }
  )
}
