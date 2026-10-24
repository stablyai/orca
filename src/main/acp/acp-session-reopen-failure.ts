import { agentSessionFailureFact } from '../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import type { AgentSessionProviderHandleLink } from '../../shared/agent-session-provider-handle'
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import { AcpAuthRequiredError, AcpRpcError } from './acp-errors'
import type { AcpStructuredLaunch } from './acp-structured-launch-resolution'

const ACP_RESOURCE_NOT_FOUND = -32002
export const ACP_REOPEN_FAILED = 'ACP agent could not reopen its saved session; starting a new one'

export function acpReopenTakeover(
  error: unknown,
  resume: NonNullable<AcpStructuredLaunch['resume']>,
  start: { over: boolean; now: number; warn: (fields: { scope: string; error: unknown }) => void }
): Pick<AgentSessionProviderHandleLink, 'supersedesKey' | 'replaces'> {
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
