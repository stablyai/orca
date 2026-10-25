/** Use graph-sequenced evidence: self-consistency cannot prove attachment, while pending spawns and lost graphs cannot prove detachment (#18191, #7587). */
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import { parsePaneKey } from '../../shared/stable-pane-id'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import type { PtyPane } from './terminal/surface/pty-pane-query'

export type RecordedPtySurface = Pick<
  RuntimePtyWorktreeRecord,
  'ptyId' | 'tabId' | 'paneKey' | 'surfaceRecordedAtGraphSequence'
>

/** Restored claims cannot overrule a witnessed graph drop; default them to no standing (#18191). */
export const SURFACE_CLAIM_WITHOUT_STANDING = 0

/** Allow the one serialized renderer graph already in flight when a spawn names its pane (#7587). */
export function spawnSurfaceClaimSequence(graphSequence: number): number {
  return graphSequence + 1
}

/** Write pane and graph standing together; main-owned layouts store no duplicate claim. */
export function recordPtySurfaceClaim(
  pty: RecordedPtySurface,
  paneKey: string | null,
  graphSequence: number
): void {
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    return
  }
  // Replaying a claim adds no evidence but must preserve its existing graph standing.
  pty.surfaceRecordedAtGraphSequence =
    paneKey === pty.paneKey
      ? Math.max(
          pty.surfaceRecordedAtGraphSequence ?? SURFACE_CLAIM_WITHOUT_STANDING,
          graphSequence
        )
      : graphSequence
  pty.paneKey = paneKey
}

export function recordPtySurface(
  pty: RecordedPtySurface,
  tabId: string,
  paneKey: string,
  graphSequence: number
): void {
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    return
  }
  pty.tabId = tabId
  recordPtySurfaceClaim(pty, paneKey, graphSequence)
}

/** Drops a PTY's surface claim; layout-owner builds keep none. */
export function forgetPtySurface(pty: RecordedPtySurface): void {
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    return
  }
  pty.tabId = null
  pty.paneKey = null
}

export type PtySurfaceTopology = {
  /** Monotonic count of authoritative graph statements applied so far. */
  graphSequence: number
  /** The ptyId the graph currently binds to this pane, or undefined when it holds no such pane. */
  ptyIdHoldingPane: (tabId: string, leafId: string) => string | null | undefined
}

/** Keep an uncontradicted claim; false reports a live PTY whose surface is gone. */
export function ptyHoldsRecordedSurface(
  ptyId: string,
  recorded: PtyPane,
  topology: PtySurfaceTopology
): boolean {
  const pane = parsePaneKey(recorded.paneKey ?? '')
  if (!recorded.tabId || !pane || pane.tabId !== recorded.tabId) {
    return false
  }
  if (recorded.recordedAtGraphSequence >= topology.graphSequence) {
    return true
  }
  return topology.ptyIdHoldingPane(pane.tabId, pane.leafId) === ptyId
}
