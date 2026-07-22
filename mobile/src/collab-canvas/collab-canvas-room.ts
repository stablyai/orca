/**
 * Mobile room URI builder — same contract as desktop collabCanvasRoomUri.
 * Keeps tablet/Nord and desktop on one sync room key (boardId).
 */

export const MOBILE_DEFAULT_COLLAB_SYNC_ORIGIN = 'ws://node-a:5858'

export function mobileCollabCanvasRoomUri(syncOrigin: string, boardId: string): string {
  return `${syncOrigin.replace(/\/+$/, '')}/connect/${encodeURIComponent(boardId)}`
}

export function resolveMobileCollabSyncOrigin(override?: string | null): string {
  const trimmed = override?.trim()
  if (!trimmed) return MOBILE_DEFAULT_COLLAB_SYNC_ORIGIN
  if (/^wss?:\/\//.test(trimmed)) return trimmed.replace(/\/+$/, '')
  return `ws://${trimmed.replace(/\/+$/, '')}`
}
