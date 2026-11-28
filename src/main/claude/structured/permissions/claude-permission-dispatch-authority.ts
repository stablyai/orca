import type { ClaudeSession } from '../claude-structured-session-state'

/** A ladder's writes belong to its request and the child it started on: a newer request, a
 *  revoked child (closed, stopped or replaced), the operation's abort or a closed connection
 *  withholds the rest and drops Claude's late answers. */
export type ClaudePermissionWriteOptions = { timeoutMs?: number; signal?: AbortSignal }

/** This child takes no more permission writes or notices: it ended, or a host cut still holds. */
export function claudeChildPermissionCut(session: ClaudeSession): boolean {
  return (
    session.permissionDispatchRevoked === true ||
    (session.permissionDispatchCuts ?? 0) > 0 ||
    session.connection.closed ||
    session.connection.handedOff === true
  )
}

export function claudePermissionWriteAdmitted(
  session: ClaudeSession,
  request: number,
  signal: AbortSignal | undefined
): () => boolean {
  return () =>
    !claudeChildPermissionCut(session) &&
    signal?.aborted !== true &&
    session.permissionModeRequests === request &&
    session.delivery.ready
}

/** The host's cut (or its release) of one exact child (sessionId, fence, acquisition generation):
 *  each release undoes one cut, so overlapping ends hold until all release; a replacement or a
 *  later acquisition keeps its own authority. */
export function revokeClaudePermissionDispatch(
  sessions: ReadonlyMap<string, ClaudeSession>
): (sessionId: string, fence: number, acquisitionGeneration: string, revoked: boolean) => void {
  return (sessionId, fence, acquisitionGeneration, revoked) => {
    const session = sessions.get(sessionId)
    if (session?.fence === fence && session.acquisitionGeneration === acquisitionGeneration) {
      session.permissionDispatchCuts = Math.max(
        0,
        (session.permissionDispatchCuts ?? 0) + (revoked ? 1 : -1)
      )
    }
  }
}
