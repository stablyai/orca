// What takes over when an ACP agent cannot reopen the session a chat proved. A session this chat
// created and never exchanged a turn on is superseded, whatever the load error: there was nothing
// to remember. Any other is replaced by a new session that names it, and the chat says once that
// the agent forgot: the row names the lost conversation, so a later start can tell whether it was
// ever written.

import { agentSessionFailureFact } from '../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import type { AgentSessionProviderHandleLink } from '../../shared/agent-session-provider-handle'
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import { AcpAuthRequiredError } from './acp-errors'
import type { AcpStructuredLaunch } from './acp-structured-launch-resolution'

export const ACP_REOPEN_FAILED = 'ACP agent could not reopen its saved session; starting a new one'

/** The fields the new session's link carries; rethrows `error` when the start must fail instead. */
export function acpReopenTakeover(
  error: unknown,
  resume: NonNullable<AcpStructuredLaunch['resume']>,
  start: { over: boolean; now: number; warn: (fields: { scope: string; error: unknown }) => void }
): Pick<AgentSessionProviderHandleLink, 'supersedesKey' | 'replaces'> {
  // Signed out, or the start is over (Close, Stop, a lost agent): a new session would not help.
  if (error instanceof AcpAuthRequiredError || start.over) {
    throw error
  }
  // Why: any error, or an agent whose load always fails would grow the chain on every start.
  if (resume.mayBeUnsaved()) {
    return { supersedesKey: resume.key }
  }
  start.warn({ scope: 'acp-restore-failed', error })
  return { replaces: { key: resume.key, reason: 'restore-failed', replacedAt: start.now } }
}

/** The provider item key of the row saying the conversation under chain key `lostKey` was lost. */
export function acpSessionNotRestoredItem(lostKey: string): string {
  return `session-not-restored:${lostKey}`
}

/** The one row a lost conversation gets: the agent no longer remembers what came before. */
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
