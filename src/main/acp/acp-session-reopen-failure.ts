import {
  agentSessionFailureFact,
  providerDiagnostic,
  withProviderDiagnostic
} from '../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session/failures/agent-session-failure-words'
import type { AgentSessionProviderHandleLink } from '../../shared/agent-session/lifecycle/agent-session-provider-handle'
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import { AgentSessionAcquisitionRefusal } from '../native-chat/agent-session-wire/structured-agent-session-adapter-errors'
import { AcpAgentError, AcpAuthRequiredError, AcpRpcError } from './acp-errors'
import type { AcpStructuredLaunch } from './acp-structured-launch-resolution'

const ACP_RESOURCE_NOT_FOUND = -32002
const ACP_INTERNAL_ERROR = -32603

/** Only the agent's not-found answer to the load or resume addressed to this saved session. */
export function isAcpSavedSessionMissing(
  error: unknown,
  sessionId: string
): error is AcpAgentError {
  return (
    error instanceof AcpAgentError &&
    (error.request?.method === 'session/load' || error.request?.method === 'session/resume') &&
    error.request.sessionId === sessionId &&
    (error.code === ACP_RESOURCE_NOT_FOUND ||
      (error.code === ACP_INTERNAL_ERROR && sessionNotFoundDetail(error.data) === sessionId))
  )
}

// Some agents wrap a missing session in an internal error that names it exactly.
function sessionNotFoundDetail(data: unknown): string | null {
  const prefix = 'ACP session not found: '
  if (typeof data !== 'object' || data === null || !('details' in data)) {
    return null
  }
  const { details } = data
  return typeof details === 'string' && details.startsWith(prefix)
    ? details.slice(prefix.length)
    : null
}

export function acpReopenTakeover(
  error: unknown,
  resume: NonNullable<AcpStructuredLaunch['resume']>,
  start: { over: boolean }
): Pick<AgentSessionProviderHandleLink, 'supersedesKey'> {
  // A replacement session cannot resolve sign-in failure or an abandoned start.
  if (error instanceof AcpAuthRequiredError || start.over) {
    throw error
  }
  if (
    error instanceof AcpRpcError &&
    error.code === ACP_RESOURCE_NOT_FOUND &&
    resume.mayBeUnsaved()
  ) {
    return { supersedesKey: resume.key }
  }
  if (isAcpSavedSessionMissing(error, resume.sessionId)) {
    throw withProviderDiagnostic(
      Object.assign(new AgentSessionAcquisitionRefusal(error.message, 'savedConversationMissing'), {
        cause: error
      }),
      providerDiagnostic(error.message, 'log')
    )
  }
  throw error
}

export function acpSessionNotRestoredItem(lostKey: string): string {
  return `session-not-restored:${lostKey}`
}

export function acpSessionNotRestoredRow(
  lostKey: string,
  providerSessionId: string,
  agentName: string
): ProviderTimelineEvent[] {
  return [
    {
      type: 'item.update',
      item: acpSessionNotRestoredItem(lostKey),
      body: {
        kind: 'status',
        tone: 'warning',
        ...agentSessionFailureWords(agentSessionFailureFact('sessionNotRestored'), {
          surface: 'row',
          agentName
        })
      },
      join: { thread: providerSessionId }
    }
  ]
}
