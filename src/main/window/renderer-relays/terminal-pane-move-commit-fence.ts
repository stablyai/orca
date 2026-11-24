import type { TerminalLeafMoveResult } from '../../../shared/workspace-layout/terminal-topology/terminal-leaf-move'

// Why its own module: the plain-Node runtime commits leaf moves too, so this must stay Electron-free.

/** The renderer a move was asked of (its WebContents), compared by identity. */
export type PaneMoveRenderer = { readonly id: number }

/** A client's pane move its window is carrying out. */
export type RelayedPaneMove = {
  /** The renderer asked to make the move; only it may commit it. */
  sender: PaneMoveRenderer
  /** The client was told the move timed out, so the window may no longer commit it. */
  timedOut: boolean
  /** The window is committing, so neither the deadline nor the window going away decides the answer. */
  claim: (committed: Promise<TerminalLeafMoveResult>) => void
  answer: (result: TerminalLeafMoveResult) => void
}

/** Client moves a window is still carrying out, by the new tab's id. */
const relayedPaneMoves = new Map<string, RelayedPaneMove>()

/** Fences the new tab's id for one move; null while another move still holds it. */
export function holdRelayedPaneMove(
  targetTabId: string,
  relayed: RelayedPaneMove
): (() => void) | null {
  if (relayedPaneMoves.has(targetTabId)) {
    return null
  }
  relayedPaneMoves.set(targetTabId, relayed)
  return () => {
    if (relayedPaneMoves.get(targetTabId) === relayed) {
      relayedPaneMoves.delete(targetTabId)
    }
  }
}

/**
 * Commits a window's pane move. A move a client asked for commits nothing once the client was told
 * it timed out, and a committed one answers the client at once, so the client never hears a refusal
 * for a pane the host moved.
 */
export function commitRelayedPaneMove(
  sender: PaneMoveRenderer,
  targetTabId: string,
  commit: () => Promise<TerminalLeafMoveResult>
): Promise<TerminalLeafMoveResult> {
  const relayed = relayedPaneMoves.get(targetTabId)
  if (!relayed || relayed.sender !== sender) {
    return commit()
  }
  if (relayed.timedOut) {
    return Promise.resolve({ status: 'refused', reason: 'pane_unavailable' })
  }
  const committed = commit().then((result) => {
    if (result.status === 'moved') {
      relayed.answer(result)
    }
    return result
  })
  relayed.claim(committed)
  return committed
}
