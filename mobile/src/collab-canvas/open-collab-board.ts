/**
 * Host-panel entry: open a collab board route for a workspace.
 * Shared by Nord + tablet so both land on the same boardId room as desktop.
 */
import type { Router } from 'expo-router'

export type OpenCollabBoardArgs = {
  hostId: string
  boardId: string
  /** Optional override; defaults to mesh node-a inside the route. */
  syncOrigin?: string
}

/** Path used by Expo Router for the board surface. */
export function collabBoardRoutePath(args: OpenCollabBoardArgs): string {
  const base = `/h/${encodeURIComponent(args.hostId)}/board/${encodeURIComponent(args.boardId)}`
  if (args.syncOrigin) {
    return `${base}?syncOrigin=${encodeURIComponent(args.syncOrigin)}`
  }
  return base
}

/** Navigate from host panel / session chrome into the board WebView. */
export function openCollabBoardFromHostPanel(
  router: Pick<Router, 'push'>,
  args: OpenCollabBoardArgs
): void {
  router.push(collabBoardRoutePath(args) as never)
}
