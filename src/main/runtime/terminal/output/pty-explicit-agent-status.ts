import type { ProcessedAgentStatusChunk } from '../../../../shared/agent-status/transport/agent-status-osc'
import type { RuntimePtyWorktreeRecord } from '../records/runtime-terminal-state-records'

/** Retain a chunk's latest first-party status on the PTY record, including the program's sign-in block. */
export function recordPtyExplicitAgentStatus(
  pty: RuntimePtyWorktreeRecord | undefined,
  chunk: ProcessedAgentStatusChunk
): void {
  if (!pty) {
    return
  }
  const facet = chunk.programStatusFacet
  const previous = pty.lastExplicitAgentStatus
  const signInSince = previous?.programSignInRequiredSince
  const latest = chunk.payloads.at(-1)
  if (!latest) {
    // A report that only moved the facet off `auth` dedupes to no payload, yet still ends the sign-in.
    if (previous && signInSince !== undefined && facet !== undefined && facet?.kind !== 'auth') {
      const { programSignInRequiredSince: _ended, ...rest } = previous
      pty.lastExplicitAgentStatus = rest
    }
    return
  }
  const fromProgram = chunk.programStatusPayloads?.has(latest)
  // The facet rides only chunks where it changed; repeats keep the kind and first stamp.
  const signInRequired =
    fromProgram &&
    latest.state === 'blocked' &&
    (facet !== undefined ? facet?.kind === 'auth' : signInSince !== undefined)
  pty.lastExplicitAgentStatus = {
    state: latest.state,
    updatedAt: Date.now(),
    sessionBoundary: latest.sessionBoundary,
    ...(latest.state === 'done' && fromProgram ? { programAtRest: true } : {}),
    ...(signInRequired ? { programSignInRequiredSince: signInSince ?? Date.now() } : {})
  }
}
