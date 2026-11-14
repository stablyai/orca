import { agentSessionFailureFact } from '../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../../shared/agent-session/failures/agent-session-failure-words'
import type {
  AgentSessionProviderHandleChain,
  AgentSessionProviderHandleLink
} from '../../../../shared/agent-session/lifecycle/agent-session-provider-handle'
import { parseAgentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { JournalLoad } from '../../../native-chat/agent-session-journal/replay/journal-open'
import {
  providerTimelineKeyPart,
  spelledProviderTimelineItemKey
} from '../../../native-chat/agent-session-timeline/provider-timeline-identity'
import type { ProviderTimelineEvent } from '../../../native-chat/agent-session-timeline/provider-timeline-event'
import { AcpAuthRequiredError, AcpRpcError } from '../../transport/acp-errors'
import type { AcpStructuredLaunch } from '../../launch/acp-structured-launch-resolution'
import { providerRequestTimeoutOf } from '../../../provider-process/provider-request-timeout'

import { temporaryAcpStartupAnswer } from './acp-startup-outcome'

const ACP_RESOURCE_NOT_FOUND = -32002
export const ACP_REOPEN_FAILED = 'ACP agent could not reopen its saved session; starting a new one'

export function acpReopenTakeover(
  error: unknown,
  resume: NonNullable<AcpStructuredLaunch['resume']>,
  start: { over: boolean; now: number; warn: (fields: { scope: string; error: unknown }) => void }
): Pick<AgentSessionProviderHandleLink, 'supersedesKey' | 'replaces'> {
  // A replacement session cannot resolve sign-in failure, a missed deadline or an abandoned start;
  // its own answer would replace the failure the user must see.
  if (
    error instanceof AcpAuthRequiredError ||
    temporaryAcpStartupAnswer(error) ||
    providerRequestTimeoutOf(error) ||
    start.over
  ) {
    throw error
  }
  if (
    error instanceof AcpRpcError &&
    error.code === ACP_RESOURCE_NOT_FOUND &&
    resume.mayBeUnsaved()
  ) {
    return { supersedesKey: resume.key }
  }
  start.warn({ scope: 'acp-restore-failed', error })
  return { replaces: { key: resume.key, reason: 'restore-failed', replacedAt: start.now } }
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
