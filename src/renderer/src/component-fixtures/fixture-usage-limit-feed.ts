// Fixtures' stand-in for the local host's status feed, listing sessions stopped on their usage limit.
import { botHostTarget } from '@/lib/bot-hosts'
import { getStructuredAgentSessionStatusFeed } from '@/runtime/native-chat/status/structured-agent-session-status-feed'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session/agent-session-wire'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host/execution-host'

export type FixtureUsageLimitStop = {
  sessionId: string
  workspaceId: string
  name?: string
  resetsAt: number
  /** Orca continues it at the reset. */
  auto: boolean
}

export function stubUsageLimitFeed(stops: readonly FixtureUsageLimitStop[]): void {
  const feed = getStructuredAgentSessionStatusFeed(botHostTarget(LOCAL_EXECUTION_HOST_ID))
  const snapshot = new Map(
    stops.map((stop): [string, AgentSessionStatusSummary] => [
      stop.sessionId,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: rows read only these fields.
      {
        sessionId: stop.sessionId,
        workspaceId: stop.workspaceId,
        agent: 'claude',
        status: null,
        latestPrompt: '',
        updatedAt: 0,
        ...(stop.name ? { conversationName: stop.name } : {}),
        usageLimitContinue: {
          turnItemId: `cut-${stop.sessionId}`,
          resetsAt: stop.resetsAt,
          state: stop.auto ? 'scheduled' : 'off'
        }
      } as AgentSessionStatusSummary
    ])
  )
  Object.assign(feed, {
    activate: () => () => {},
    getSnapshot: () => snapshot,
    subscribe: () => () => {}
  })
}
