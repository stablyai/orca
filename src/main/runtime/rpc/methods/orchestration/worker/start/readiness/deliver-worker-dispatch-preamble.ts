import type { RuntimeTerminalSend } from '../../../../../../../../shared/runtime-terminal-send-contract'
import type { OrcaRuntimeService } from '../../../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../../../orchestration/db/orchestration-db'
import {
  formatOrcaSessionAddress,
  isOrcaSessionId
} from '../../../../../../../../shared/orca-session-address'
import { canonicalOrcaSessionId } from '../../../../../../orchestration/addressing/session-lineage/canonical-orca-session-id'
import {
  orcaSessionIdOrHandle,
  resolveDispatchAssigneeParty
} from '../../../../../../orchestration/addressing/orchestration-party'
import { buildDispatchPreamble } from '../../../../../../orchestration/workers/launch/worker-dispatch-preamble'
import { sendAgentTurn } from '../../../../../../orchestration/turn-delivery/send-agent-turn'
import { createWorkerBriefWriteGuard } from '../../../../../../terminal/wait/launched-agent-write-guard'
import { sendStructuredWorkerPreamble } from '../../../structured-workers/orchestration-structured-worker-session'
import { chatAssigneeOf } from '../../../chat-assignee-admission'
import { OrchestrationError } from '../../../../../../orchestration/orchestration-error'
import { sendChatTask, type ChatTaskDelivery } from '../../../chat-task-delivery'
import { dispatchTaskSource } from '../../../../../../orchestration/coordinator/dispatch/dispatch-task-source'
import type { AgentMessageSource } from '../../../../../../../../shared/agent-session/agent-session-message-source'
import type { WorkerTurnStartObservation } from './worker-start-turn-observation'
import type { createStructuredWorkerSessionForWorktree } from '../placement/worker-placement-topology'

type StructuredSession = Awaited<ReturnType<typeof createStructuredWorkerSessionForWorktree>> | null

/** Teach every worker the same verbs; vary only identity/surface wording and transport.
 * PTY writes return queued/accepted; structured turns may stay held while agents start. Unobserved starts remain unknown, never torn down.
 * Busy chat tasks queue as cards, like input waiting in busy terminals. */
export async function deliverWorkerDispatchPreamble(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  structuredSession: StructuredSession
  terminalHandle: string
  dispatchId: string
  dispatchDepth: number
  runId: string
  taskId: string
  taskSpec: string
  coordinatorHandle: string
  devMode: boolean | undefined
  requestId: string
  /** The agent this worker start launched into `terminalHandle`; absent for a caller's terminal. */
  launchedAgent?: string | null
  /** The caller's readiness budget; a structured worker's start counts against it. */
  readinessTimeoutMs?: number
}): Promise<{
  prompt?: RuntimeTerminalSend['prompt']
  structuredTurnStart?: WorkerTurnStartObservation
}> {
  const { runtime, structuredSession, terminalHandle } = args
  // A reused structured worker is a chat too, though its handle is not an Orca session ID.
  const chat = structuredSession
    ? null
    : chatAssigneeOf(resolveDispatchAssigneeParty(terminalHandle, args.db))
  const record = structuredSession?.host.deps.store.getRecord(structuredSession.identity.sessionId)
  const preamble = record?.executionPolicy
    ? [
        'Complete this one bounded task using the admitted workspace and tools. Do not delegate.',
        'After verification call orca_worker_report once with status succeeded, failed or needs_context and a concise summary.',
        'The report reaches the dispatch owner. The owner decides final acceptance.',
        args.taskSpec
      ].join('\n\n')
    : record?.advisoryPolicy
      ? [
          'Answer this one consultation using only the admitted artifact snapshots.',
          'Use read_artifact and search_artifacts as needed, then call mcp__orca_advisor__report_advice once.',
          'A recommendation requires evidence, uncertainty and next_test. Otherwise report inconclusive, conflict, timeout or error.',
          'The report ends this consultation. The owner decides whether to act on it.',
          args.taskSpec
        ].join('\n\n')
      : buildDispatchPreamble({
          // Only depth gates nesting; resolve structured callers' workspace so they can dispatch like PTY workers.
          canDispatchSubWorkers: args.dispatchDepth < runtime.getNestedWorkerMaxDepth(),
          taskId: args.taskId,
          dispatchId: args.dispatchId,
          taskSpec: args.taskSpec,
          coordinatorHandle: orcaSessionIdOrHandle(args.coordinatorHandle, args.db),
          coordinatedFrom: args.db.getPeerRun(args.runId)?.home_label,
          // Its mailbox stays keyed by the handle; its commands name its Orca session ID, which binds to it.
          workerHandle:
            structuredSession && isOrcaSessionId(structuredSession.identity.sessionId)
              ? formatOrcaSessionAddress(
                  canonicalOrcaSessionId(structuredSession.identity.sessionId)
                )
              : chat
                ? formatOrcaSessionAddress(chat)
                : terminalHandle,
          devMode: args.devMode,
          cliCommand: runtime.getTerminalOrchestrationCliCommand(terminalHandle),
          unreadMail:
            args.db.getLatestUnreadMessageSequence(`dispatch:${args.dispatchId}`) !== undefined
        })
  if (chat) {
    const dispatch = args.db.getDispatchContextById(args.dispatchId)
    if (!dispatch) {
      throw new OrchestrationError(
        'dispatch_not_found',
        `Dispatch ${args.dispatchId} was not found.`
      )
    }
    const from = workerTaskSource(args)
    const delivery = await sendChatTask({ db: args.db, dispatch, from, preamble })
    return { structuredTurnStart: chatTaskTurnStart(delivery) }
  }
  if (structuredSession) {
    const delivery = await sendStructuredWorkerPreamble({
      host: structuredSession.host,
      sessionId: structuredSession.identity.sessionId,
      dispatchId: args.dispatchId,
      preamble,
      from: workerTaskSource(args),
      ...(args.readinessTimeoutMs === undefined ? {} : { budgetMs: args.readinessTimeoutMs })
    })
    return {
      structuredTurnStart:
        delivery === 'accepted'
          ? { verdict: 'observed' }
          : {
              verdict: 'unobserved',
              reason:
                'The dispatch preamble was accepted, but the agent had not started to take it. It ' +
                'is delivered when the agent starts; if the worker then reports, this Dispatch ' +
                'settles normally.'
            }
    }
  }
  // A shell back at its prompt also reads as ready, so the brief needs the agent found in front.
  const briefGuard = createWorkerBriefWriteGuard(runtime, args.launchedAgent, !!args.launchedAgent)
  try {
    const sent = await sendAgentTurn({
      kind: 'terminal',
      runtime,
      handle: terminalHandle,
      ...(briefGuard ? { beforeWrite: briefGuard.beforeWrite } : {}),
      turn: { purpose: 'dispatch-preamble', body: preamble, operationId: args.requestId }
    })
    return { prompt: sent.prompt }
  } finally {
    briefGuard?.dispose()
  }
}

function chatTaskTurnStart(delivery: ChatTaskDelivery): WorkerTurnStartObservation {
  switch (delivery) {
    case 'accepted':
      return { verdict: 'observed' }
    case 'pending':
      return {
        verdict: 'unobserved',
        reason:
          "The task was accepted, but the chat's agent had not started to take it. If the worker " +
          'then reports, this Dispatch settles normally.'
      }
    case 'queued':
      return {
        verdict: 'unobserved',
        queued: true,
        reason:
          "The task is waiting as a card in the chat's queue and is sent when the queue reaches " +
          'it. If the worker then reports, this Dispatch settles normally. worker-abandon ' +
          'settles the Dispatch but does not remove the card from the chat.'
      }
  }
}

/** Who the task is from, for a worker whose chat shows the sender. */
function workerTaskSource(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  dispatchId: string
  runId: string
  taskId: string
  coordinatorHandle: string
}): AgentMessageSource {
  return dispatchTaskSource({
    db: args.db,
    dispatch: { id: args.dispatchId, run_id: args.runId, task_id: args.taskId },
    from: args.coordinatorHandle,
    senderSnapshot: (party, reported) =>
      args.runtime.orchestrationSenderNames.snapshotOf(party, reported)
  })
}
