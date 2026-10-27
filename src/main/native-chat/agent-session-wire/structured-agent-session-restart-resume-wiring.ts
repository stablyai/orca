import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionMutationEnvelope,
  AgentSessionMutationResult,
  AgentSessionSendResult,
  AgentSessionWireRefusal
} from '../../../shared/agent-session-wire'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import { MAX_TIMER_DELAY_MS } from '../../../shared/timer-delay'
import type { SendSettlementWaitOptions } from './structured-agent-session-send-settlement'

export type StructuredAgentSessionRestartResumeSurfaces = {
  revealSession: (
    sessionId: string
  ) => Promise<{ readable: boolean; openRefusal?: AgentSessionWireRefusal }>
  send: (input: {
    envelope: AgentSessionMutationEnvelope
    body: AgentJournalMessageItem
    beforeRun?: () => void
  }) => Promise<AgentSessionMutationResult<AgentSessionSendResult>>
  awaitSendSettlement: (
    sessionId: string,
    clientMessageId: string
  ) => Promise<{ value: AgentSessionSendResult } | undefined>
  awaitSendHandedOver: (
    sessionId: string,
    clientMessageId: string
  ) => Promise<{ value: AgentSessionSendResult } | undefined>
  readChildWork: (sessionId: string) => readonly AgentChildWorkView[] | undefined
  childWorkOpen: (sessionId: string) => boolean
  publishStatus?: (sessionId: string) => void
  now: () => number
}

export const STRUCTURED_AGENT_SESSION_RESTART_CONTINUATION_CALLER =
  'trusted-local:restart-continuation'

type RestartResumeHostBindings = {
  revealSession: StructuredAgentSessionRestartResumeSurfaces['revealSession']
  send: (
    caller: { callerKey: string },
    params: {
      envelope: AgentSessionMutationEnvelope
      body: AgentJournalMessageItem
      beforeRun?: () => void
    }
  ) => Promise<AgentSessionMutationResult<AgentSessionSendResult>>
  waitForSendSettlement: (
    sessionId: string,
    clientMessageId: string,
    options: SendSettlementWaitOptions
  ) => Promise<{ value: AgentSessionSendResult } | undefined>
}

export function structuredAgentSessionRestartResumeSurfaces(
  host: RestartResumeHostBindings,
  now: () => number
): Omit<StructuredAgentSessionRestartResumeSurfaces, 'readChildWork' | 'childWorkOpen'> {
  return {
    revealSession: host.revealSession,
    send: (params) =>
      host.send({ callerKey: STRUCTURED_AGENT_SESSION_RESTART_CONTINUATION_CALLER }, params),
    // Provider settlement decides delivery; cold startup may exceed ordinary client waits.
    awaitSendSettlement: (sessionId, clientMessageId) =>
      host.waitForSendSettlement(sessionId, clientMessageId, { budgetMs: MAX_TIMER_DELAY_MS }),
    // Release batch capacity at handover/start failure or an inconclusive ended wait.
    awaitSendHandedOver: (sessionId, clientMessageId) =>
      host.waitForSendSettlement(sessionId, clientMessageId, {
        until: 'handed-over',
        budgetMs: MAX_TIMER_DELAY_MS
      }),
    now
  }
}
