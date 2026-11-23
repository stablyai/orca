// Attribute a restart continuation's outcome in the chat, and release the restart's hold on its queue.

import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { RESTART_CONTINUATION_ROW_PREFIX } from '../../../../shared/agent-session/lifecycle/stopping/agent-session-stop-row-identity'
import {
  AGENT_SESSION_RESTART_CONTINUATION_NOTE,
  AGENT_SESSION_RESTART_CONTINUATION_REFUSED_NOTE,
  AGENT_SESSION_RESTART_CONTINUATION_UNCONFIRMED_NOTE,
  AGENT_SESSION_RESTART_NOT_CONNECTED_NOTE
} from '../../../../shared/agent-session/lifecycle/stopping/agent-session-restart-continuation'
import type {
  StructuredAgentSessionContinuationDeps,
  StructuredAgentSessionContinuationHost,
  StructuredAgentSessionContinuationOutcome
} from './structured-agent-session-restart-continuation'

export function restartNoteWriter(
  host: Pick<StructuredAgentSessionContinuationHost, 'sessions' | 'conversationFence' | 'now'>
): StructuredAgentSessionContinuationDeps['note'] {
  return async (sessionId, text, tone) => {
    const session = host.sessions.get(sessionId)
    const fence = host.conversationFence(sessionId)
    if (!session || fence === null) {
      return
    }
    await session.journal.appendItem(
      {
        provider: 'orca',
        clientMessageId: `${RESTART_CONTINUATION_ROW_PREFIX}${sessionId}:${host.now()}`
      },
      { kind: 'status', text, ...(tone ? { tone } : {}) },
      { fence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  }
}

/** Personal messages meet these refusals too; advise retry instead. */
const OWNERSHIP_REFUSALS = new Set([
  'agent_session_conflict',
  'agent_session_ownership_unknown',
  'execution_owner_reconciling'
])

export async function noteOutcome(
  deps: Pick<StructuredAgentSessionContinuationDeps, 'note' | 'logger' | 'liftRestartHold'>,
  sessionId: string,
  result: StructuredAgentSessionContinuationOutcome
): Promise<void> {
  // Any outcome ends the restart's claim on the queue; holding cards on a lost continuation strands them.
  try {
    await deps.liftRestartHold(sessionId)
  } catch {
    deps.logger.warn('releasing queued messages after a restart continuation failed', {
      scope: 'restart-continuation-queue',
      sessionId
    })
  }
  if (result.outcome === 'continued') {
    // Attribute only accepted dispatch; note failure must not turn delivered work into failure.
    try {
      await deps.note(sessionId, AGENT_SESSION_RESTART_CONTINUATION_NOTE)
    } catch {
      reportNoteFailed(deps, sessionId)
    }
  } else {
    await noteNotContinued(
      deps,
      sessionId,
      result.outcome !== 'refused'
        ? 'unconfirmed'
        : OWNERSHIP_REFUSALS.has(result.reason ?? '')
          ? 'not-connected'
          : 'refused'
    )
  }
}

/** Persist failure in chat beyond transient toast/dialog state. */
export async function noteNotContinued(
  deps: Pick<StructuredAgentSessionContinuationDeps, 'note' | 'logger'>,
  sessionId: string,
  outcome: 'refused' | 'not-connected' | 'unconfirmed'
): Promise<void> {
  try {
    await (outcome === 'unconfirmed'
      ? deps.note(sessionId, AGENT_SESSION_RESTART_CONTINUATION_UNCONFIRMED_NOTE, 'warning')
      : deps.note(
          sessionId,
          outcome === 'refused'
            ? AGENT_SESSION_RESTART_CONTINUATION_REFUSED_NOTE
            : AGENT_SESSION_RESTART_NOT_CONNECTED_NOTE,
          'error'
        ))
  } catch {
    reportNoteFailed(deps, sessionId)
  }
}

/** Omit errors that may contain private recovery payloads. */
function reportNoteFailed(
  deps: Pick<StructuredAgentSessionContinuationDeps, 'logger'>,
  sessionId: string
): void {
  deps.logger.warn('writing a restart continuation note failed', {
    scope: 'restart-continuation-note',
    sessionId
  })
}
