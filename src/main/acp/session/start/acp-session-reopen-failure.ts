import { z } from 'zod'
import { agentSessionFailureFact } from '../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../../shared/agent-session/failures/agent-session-failure-words'
import type { AgentSessionProviderHandleLink } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle'
import type { ProviderTimelineEvent } from '../../../native-chat/agent-session-timeline/provider-timeline-event'
import { AcpAgentError, AcpAuthRequiredError, AcpRpcError } from '../../transport/acp-errors'
import type { AcpDialect } from '../../acp-dialects/acp-dialect'
import type { InitializeResponse } from '../../generated/acp-protocol.generated'
import type { AcpStructuredConnection } from '../../process/acp-structured-connection'
import type { AcpStructuredLaunch } from '../../launch/acp-structured-launch-resolution'
import { providerRequestTimeoutOf } from '../../../provider-process/provider-request-timeout'

import { temporaryAcpStartupAnswer } from './acp-startup-outcome'

const ACP_RESOURCE_NOT_FOUND = -32002
// Without a `cwd`, OpenCode 2.x lists every folder's sessions.
const sessionListPage = z.object({
  sessions: z.array(z.looseObject({ sessionId: z.string(), cwd: z.string() })),
  nextCursor: z.string().nullish()
})
export const ACP_REOPEN_FAILED = 'ACP agent could not reopen its saved session; starting a new one'

export async function acpReopenTakeover(
  error: unknown,
  resume: NonNullable<AcpStructuredLaunch['resume']>,
  start: { over: boolean; now: number; warn: (fields: { scope: string; error: unknown }) => void }
): Promise<Pick<AgentSessionProviderHandleLink, 'supersedesKey' | 'replaces'>> {
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
    (await resume.mayBeUnsaved())
  ) {
    return { supersedesKey: resume.key }
  }
  start.warn({ scope: 'acp-restore-failed', error })
  return { replaces: { key: resume.key, reason: 'restore-failed', replacedAt: start.now } }
}

/** The folder the agent now keeps a session in that it refused to reopen from `cwd`; null when it
 *  did not refuse for that reason or no longer lists the session elsewhere. */
export async function acpSessionOtherFolder(
  error: unknown,
  sessionId: string,
  cwd: string,
  input: {
    dialect: AcpDialect
    initialized: InitializeResponse
    connection: Pick<AcpStructuredConnection, 'listSessions'>
    assertStarting: () => void
  }
): Promise<string | null> {
  if (
    !(error instanceof AcpAgentError) ||
    !input.dialect.sessionInOtherFolder?.(error, sessionId, cwd) ||
    input.initialized.agentCapabilities?.sessionCapabilities?.list == null
  ) {
    return null
  }
  let cursor: string | undefined
  do {
    const page = sessionListPage.parse(
      await input.connection.listSessions(cursor ? { cursor } : {})
    )
    input.assertStarting()
    const listed = page.sessions.find((session) => session.sessionId === sessionId)
    if (listed) {
      return listed.cwd === cwd ? null : listed.cwd
    }
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return null
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
      lossWarning: true,
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
