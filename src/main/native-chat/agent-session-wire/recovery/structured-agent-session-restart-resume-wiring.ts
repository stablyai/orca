import type { AgentJournalMessageItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type {
  AgentSessionMutationEnvelope,
  AgentSessionMutationResult,
  AgentSessionSendResult
} from '../../../../shared/agent-session/agent-session-wire'
import type { AgentSessionWireRefusal } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import type { AgentChildWorkView } from '../../../../shared/agent-status/child-work/agent-status-child-work-view'
import { MAX_TIMER_DELAY_MS } from '../../../../shared/concurrency/timer-delay'
import {
  STRUCTURED_AGENT_SESSION_START_WAIT_MS,
  type SendSettlementWaitOptions
} from '../delivery/structured-agent-session-send-settlement'

export type StructuredAgentSessionRestartResumeSurfaces = {
  revealSession: (
    sessionId: string
  ) => Promise<{ readable: boolean; openRefusal?: AgentSessionWireRefusal }>
  send: (input: {
    envelope: AgentSessionMutationEnvelope
    body: AgentJournalMessageItem
    beforeRun?: () => void | Promise<void>
  }) => Promise<AgentSessionMutationResult<AgentSessionSendResult>>
  awaitSendSettlement: (
    sessionId: string,
    clientMessageId: string
  ) => Promise<{ value: AgentSessionSendResult } | undefined>
  awaitSendHandedOver: (
    sessionId: string,
    clientMessageId: string
  ) => Promise<{ value: AgentSessionSendResult } | undefined>
  awaitSendDispatched: (
    sessionId: string,
    clientMessageId: string
  ) => Promise<{ value: AgentSessionSendResult } | undefined>
  awaitSendDecided: (
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
      beforeRun?: () => void | Promise<void>
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
    // Bounded: a provider that never takes the send must not hold the restart action open.
    awaitSendDispatched: (sessionId, clientMessageId) =>
      host.waitForSendSettlement(sessionId, clientMessageId, {
        until: 'dispatched',
        budgetMs: STRUCTURED_AGENT_SESSION_START_WAIT_MS
      }),
    // After a give-up: the provider's later accept or reject, for as long as the chat is open.
    awaitSendDecided: (sessionId, clientMessageId) =>
      host.waitForSendSettlement(sessionId, clientMessageId, {
        until: 'decided',
        budgetMs: MAX_TIMER_DELAY_MS
      }),
    now
  }
}
