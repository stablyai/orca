import type { ClaudeSession } from '../claude-structured-session-state'

/** A ladder's writes belong to its request and the child it started on: a newer request, a
 *  revoked child (closed, stopped or replaced), the operation's abort or a closed connection
 *  withholds the rest and drops Claude's late answers. */
export type ClaudePermissionWriteOptions = { timeoutMs?: number; signal?: AbortSignal }

export function claudePermissionWriteAdmitted(
  session: ClaudeSession,
  request: number,
  signal: AbortSignal | undefined
): () => boolean {
  return () =>
    session.permissionDispatchRevoked !== true &&
    signal?.aborted !== true &&
    session.permissionModeRequests === request &&
    !session.connection.closed &&
    session.delivery.ready
}

/** The host's revocation of one exact child (sessionId, fence, acquisition generation): a
 *  replacement or a later acquisition keeps its own authority. */
export function revokeClaudePermissionDispatch(
  sessions: ReadonlyMap<string, ClaudeSession>
): (sessionId: string, fence: number, acquisitionGeneration: string) => void {
  return (sessionId, fence, acquisitionGeneration) => {
    const session = sessions.get(sessionId)
    if (session?.fence === fence && session.acquisitionGeneration === acquisitionGeneration) {
      session.permissionDispatchRevoked = true
    }
  }
}
