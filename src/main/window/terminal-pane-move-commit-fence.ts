import type { WebContents } from 'electron'
import type { TerminalLeafMoveResult } from '../../shared/workspace-layout/terminal-leaf-move'

// Why: a window that never answers must not grow this without bound; a newer timeout evicts the oldest.
const MAX_FENCED_MOVES_PER_WINDOW = 64

/** The window's renderer that carries out and commits a relayed move. */
export type PaneMoveSender = Pick<WebContents, 'id'>

type RelayedPaneMove = {
  sender: PaneMoveSender
  onCommit: (commit: Promise<TerminalLeafMoveResult>) => void
}

/** Client moves a window is carrying out, by the new tab's id. */
const relayedMoves = new Map<string, RelayedPaneMove>()
/** New tab ids whose client was told the move timed out, oldest first. */
const fencedMovesBySender = new WeakMap<PaneMoveSender, string[]>()

/** Watches the window's commit of a client's move until the returned release is called. */
export function trackRelayedPaneMove(
  sender: PaneMoveSender,
  targetTabId: string,
  onCommit: RelayedPaneMove['onCommit']
): () => void {
  const relayed: RelayedPaneMove = { sender, onCommit }
  relayedMoves.set(targetTabId, relayed)
  return () => {
    if (relayedMoves.get(targetTabId) === relayed) {
      relayedMoves.delete(targetTabId)
    }
  }
}

/** The client heard the move timed out, so the window may not commit it later. */
export function fenceRelayedPaneMove(sender: PaneMoveSender, targetTabId: string): void {
  const fenced = fencedMovesBySender.get(sender) ?? []
  fenced.push(targetTabId)
  if (fenced.length > MAX_FENCED_MOVES_PER_WINDOW) {
    fenced.shift()
  }
  fencedMovesBySender.set(sender, fenced)
}

/** Commits a window's pane move; a move whose client was told it timed out commits nothing. */
export function commitFencedPaneMove(
  sender: PaneMoveSender,
  targetTabId: string,
  commit: () => Promise<TerminalLeafMoveResult>
): Promise<TerminalLeafMoveResult> {
  const fenced = fencedMovesBySender.get(sender)
  const fencedAt = fenced?.indexOf(targetTabId) ?? -1
  if (fenced && fencedAt !== -1) {
    fenced.splice(fencedAt, 1)
    return Promise.resolve({ status: 'refused', reason: 'pane_unavailable' })
  }
  const committed = commit()
  const relayed = relayedMoves.get(targetTabId)
  if (relayed?.sender === sender) {
    relayed.onCommit(committed)
  }
  return committed
}
