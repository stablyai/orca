import type { ProcessedAgentStatusChunk } from '../../../../shared/agent-status/transport/agent-status-osc'
import type { RuntimePtyWorktreeRecord } from '../records/runtime-terminal-state-records'

/** Display results survive a program; input readiness belongs only to its current execution. */
export function observeTerminalActionStatus(
  pty: RuntimePtyWorktreeRecord,
  chunk: ProcessedAgentStatusChunk
): void {
  const status = chunk.readinessStatus
  if (!status) {
    return
  }
  if (status.offset < (pty.commandPaint?.lastBoundaryEnd ?? -1)) {
    return
  }
  const payload = status.payload
  if (!payload) {
    pty.lastExplicitAgentStatus = null
    return
  }
  const signInSince = pty.lastExplicitAgentStatus?.programSignInRequiredSince
  const signInRequired =
    status.fromProgram &&
    payload.state === 'blocked' &&
    (chunk.programStatusFacet !== undefined
      ? chunk.programStatusFacet?.kind === 'auth'
      : signInSince !== undefined)
  pty.lastExplicitAgentStatus = {
    state: payload.state,
    updatedAt: Date.now(),
    sessionBoundary: payload.sessionBoundary,
    ...(payload.state === 'done' && status.fromProgram ? { programAtRest: true } : {}),
    ...(signInRequired ? { programSignInRequiredSince: signInSince ?? Date.now() } : {})
  }
}
