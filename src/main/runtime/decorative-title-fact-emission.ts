/**
 * Why: an agent spinner re-emits a semantically identical OSC title ~12.5x/sec (Orca's own
 * synthetic frame timer, Pi/OMP, Claude Code, Grok), and main ships every frame to the renderer
 * as its own `pty:sideEffect` message. Both renderer store writes already discard those frames
 * via `isDecorativeAgentTitleFrameChange`, so the message is pure cross-process cost.
 *
 * Why a heartbeat and not a hard drop: `agentCompletionCoordinator.observeTitle` treats an
 * arriving *working* title as "still working" and cancels a scheduled hook-`done` completion
 * inside `HOOK_DONE_QUIET_MS` (1500ms). That is exactly how a Pi/OMP milestone `done` emitted
 * mid-turn is stopped from minting a completion notification, and the frames that carry it are
 * decorative repeats. 500ms keeps 3 frames inside that window.
 */
export const DECORATIVE_TITLE_FACT_HEARTBEAT_MS = 500

export type DecorativeTitleFactEmissionInput = {
  /** The frame's decorative gate key matches the previous frame's. */
  decorativeOnly: boolean
  /** Timer-synthesized stale-working clear — carries a flag no repeat can stand in for. */
  staleWorkingTitleClear: boolean
  lastEmittedAtMs: number | null
  nowMs: number
}

export function shouldEmitTitleFactForFrame({
  decorativeOnly,
  staleWorkingTitleClear,
  lastEmittedAtMs,
  nowMs
}: DecorativeTitleFactEmissionInput): boolean {
  if (!decorativeOnly || staleWorkingTitleClear) {
    return true
  }
  if (lastEmittedAtMs === null) {
    return true
  }
  // A backwards clock step must not park the heartbeat until it catches up.
  return nowMs < lastEmittedAtMs || nowMs - lastEmittedAtMs >= DECORATIVE_TITLE_FACT_HEARTBEAT_MS
}
