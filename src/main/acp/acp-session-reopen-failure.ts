import {
  agentSessionFailureFact,
  providerDiagnostic,
  withProviderDiagnostic
} from '../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session/failures/agent-session-failure-words'
import type { AgentSessionProviderHandleChain } from '../../shared/agent-session/lifecycle/agent-session-provider-handle'
import { parseAgentJournalItemKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import type { JournalLoad } from '../native-chat/agent-session-journal/replay/journal-open'
import {
  providerTimelineKeyPart,
  spelledProviderTimelineItemKey
} from '../native-chat/agent-session-timeline/provider-timeline-identity'
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import { AgentSessionAcquisitionRefusal } from '../native-chat/agent-session-wire/providers/structured-agent-session-adapter-errors'
import { AcpAgentError, AcpAuthRequiredError } from './acp-errors'
import { providerRequestTimeoutOf } from '../provider-process/provider-request-timeout'
import { temporaryAcpStartupAnswer } from './acp-startup-outcome'

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

/** A saved session the agent could not reopen fails in place; nothing replaces it in this chat. */
export function acpReopenFailure(error: unknown, sessionId: string, over: boolean): never {
  // Sign-in failure, a temporary answer, a missed deadline or an abandoned start keeps its own error.
  if (
    error instanceof AcpAuthRequiredError ||
    temporaryAcpStartupAnswer(error) ||
    providerRequestTimeoutOf(error) ||
    over
  ) {
    throw error
  }
  if (isAcpSavedSessionMissing(error, sessionId)) {
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

/** Retry missing loss-warning rows on successful starts; unreadable journals suppress new warnings. */
export function acpUnannouncedLosses(
  readJournal: (sessionId: string) => JournalLoad | null,
  sessionId: string,
  chain: AgentSessionProviderHandleChain
): string[] {
  const lost = chain.flatMap((link) =>
    link.replaces?.reason === 'restore-failed' ? [link.replaces.key] : []
  )
  if (lost.length === 0) {
    return []
  }
  let load: JournalLoad | null
  try {
    load = readJournal(sessionId)
  } catch {
    return []
  }
  if (!load) {
    return lost
  }
  if (load.damage || load.newer) {
    return []
  }
  const written = new Set<string>()
  for (const itemId of load.state.items.keys()) {
    const identity = parseAgentJournalItemKey(itemId)
    const spelled =
      identity?.provider === 'legacy' ? spelledProviderTimelineItemKey(identity.recordId) : null
    if (spelled !== null) {
      written.add(spelled)
    }
  }
  // Warnings survive even if the replacement session that wrote them is superseded.
  return lost.filter((key) => !written.has(providerTimelineKeyPart(acpSessionNotRestoredItem(key))))
}
