import { waitForWorkerAgentReady } from '../../../../terminal/wait/launched-agent-composer-readiness'
import { sendAgentTurn } from '../../../../orchestration/turn-delivery/send-agent-turn'
import { createWorkerBriefWriteGuard } from '../../../../terminal/wait/launched-agent-write-guard'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'
import type { RuntimeTerminalCreate } from '../../../../../../shared/runtime-terminal-create-contract'
import {
  formatOrcaSessionAddress,
  isOrcaSessionId
} from '../../../../../../shared/orca-session-address'
import { canonicalOrcaSessionId } from '../../../../orchestration/addressing/session-lineage/canonical-orca-session-id'
import { sendStructuredWorkerPreamble } from '../structured-workers/orchestration-structured-worker-session'
import { awaitStructuredWorkerSetupGate } from '../worker/worker-start-structured-setup-gate'
import type {
  createStructuredWorkerSessionForWorktree,
  WorkerSetupReceipt
} from '../worker/worker-topology'
import type { FederationEffect } from './federation-effects'

export type StructuredSession = Awaited<ReturnType<typeof createStructuredWorkerSessionForWorktree>>

/** A chat's readiness is its brief being taken, so only a wait-for-setup policy gates it here. */
export function awaitFederatedWorkerReady(input: {
  runtime: OrcaRuntimeService
  structuredSession: StructuredSession | null
  terminalHandle: string
  agent: TuiAgent | undefined
  reusesTerminal: boolean
  creation: RuntimeTerminalCreate | undefined
  setup: WorkerSetupReceipt
  effects: FederationEffect[]
  timeoutMs: number
}) {
  const { runtime, timeoutMs } = input
  return input.structuredSession
    ? awaitStructuredWorkerSetupGate({
        runtime,
        setup: input.setup,
        effects: input.effects,
        timeoutMs
      })
    : waitForWorkerAgentReady(runtime, input.terminalHandle, {
        agent: input.agent,
        reusesTerminal: input.reusesTerminal,
        creation: input.creation,
        timeoutMs
      })
}

/** A chat worker's commands name its Orca session ID, which binds to it, as a local one's do. */
export function federatedWorkerAddress(
  structuredSession: StructuredSession | null,
  terminalHandle: string
): string {
  const sessionId = structuredSession?.identity.sessionId
  return sessionId && isOrcaSessionId(sessionId)
    ? formatOrcaSessionAddress(canonicalOrcaSessionId(sessionId))
    : terminalHandle
}

export function sendFederatedWorkerBrief(input: {
  runtime: OrcaRuntimeService
  structuredSession: StructuredSession | null
  terminalHandle: string
  agent: TuiAgent | undefined
  params: { dispatchId: string; runId?: string; taskId: string; terminal?: string }
  operationId: string
  preamble: string
  budgetMs: number
}) {
  return input.structuredSession
    ? sendRemoteChatWorkerBrief(
        input.structuredSession,
        input.params,
        input.preamble,
        input.budgetMs
      )
    : sendTerminalWorkerBrief(input.runtime, input.terminalHandle, {
        agent: input.agent,
        launched: !input.params.terminal,
        operationId: input.operationId,
        preamble: input.preamble
      })
}

async function sendTerminalWorkerBrief(
  runtime: OrcaRuntimeService,
  handle: string,
  brief: { agent: TuiAgent | undefined; launched: boolean; operationId: string; preamble: string }
) {
  // A shell back at its prompt also reads as ready, so the brief needs the agent found in front.
  const briefGuard = createWorkerBriefWriteGuard(runtime, brief.agent, brief.launched)
  return sendAgentTurn({
    kind: 'terminal',
    runtime,
    handle,
    ...(briefGuard ? { beforeWrite: briefGuard.beforeWrite } : {}),
    turn: { purpose: 'dispatch-preamble', operationId: brief.operationId, body: brief.preamble }
  }).finally(() => briefGuard?.dispose())
}

/** The brief as the chat's first turn, as a local chat worker gets it; one not yet taken leaves the start unknown. */
async function sendRemoteChatWorkerBrief(
  session: StructuredSession,
  params: { dispatchId: string; runId?: string; taskId: string },
  preamble: string,
  budgetMs: number
): Promise<undefined> {
  const delivery = await sendStructuredWorkerPreamble({
    host: session.host,
    sessionId: session.identity.sessionId,
    dispatchId: params.dispatchId,
    preamble,
    from: {
      kind: 'agent',
      senders: [],
      orchestration: {
        message: 'task',
        runId: params.runId ?? '',
        taskId: params.taskId,
        dispatchId: params.dispatchId
      }
    },
    budgetMs
  })
  if (delivery !== 'accepted') {
    throw new OrchestrationError(
      'operation_unknown',
      'The task was accepted, but the chat agent had not started to take it. It is delivered when the agent starts; if the worker then reports, this Dispatch settles normally.'
    )
  }
  return undefined
}
