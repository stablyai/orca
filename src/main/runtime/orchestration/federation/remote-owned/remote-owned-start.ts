import { coordinatorKeepOpenByDefault } from '../../../rpc/methods/orchestration/worker/start/worker-keep-open-default'
import { botOfSession } from '../../../../bots/bot-session-tabs'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { WorkerStartParams } from '../../../../../shared/rpc-contract/orchestration/orchestration-worker-start-params'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { RpcContext } from '../../../rpc/core'
import { prepareWorkerStart } from '../../../rpc/methods/orchestration/worker/worker-start-method'
import { resolveFederatedWorkerStartBudgets } from '../../../rpc/methods/orchestration/worker/start/launch/worker-start-budgets'
import { OrchestrationError } from '../../orchestration-error'
import { assertBotWorkTargetPairingRevision } from '../../../../bots/bot-turn-work-target'
import type { ResolvedBotWorkTargetPlacement } from '../../../../../shared/agent-session/work-target/agent-session-work-target'
import { prepareWorkerStartCard } from '../../workers/launch/worker-start-card'
import { workerLaunchAgent } from '../../workers/launch/worker-launch-observation'
import {
  recordRemoteStart,
  releaseRemotePlacement,
  reserveRemotePlacement
} from '../../db/remote-owned/remote-placements'
import {
  markRemotePlacementNeverSent,
  refuseTaskOfClosedPairing
} from '../../db/remote-owned/remote-placement-hold'
import { openRemoteRunLink } from '../../db/remote-owned/remote-run-links'
import { callRemoteOwnedServer } from './remote-owned-calls'
import { resolveCrossMachineChildParent } from '../cross-machine-child-parent'
import { remoteForwardKey } from './remote-forward-caller'
import {
  errorData,
  failedBeforeSending,
  inServerTerms,
  serverNeverAnswered
} from './remote-owned-answers'
import { forwardedChatLineage } from './remote-owned-capabilities'

export {
  forwardedChatLineage,
  invalidateWorkTargetFollowUpCapability,
  resolveWorkTargetFollowUpCapability,
  serverOwnsPlacedWorkers
} from './remote-owned-capabilities'

type StartParams = z.infer<typeof WorkerStartParams>
type StartContext = Pick<
  RpcContext,
  'runtime' | 'orchestrationCompatibilityEvidence' | 'orchestrationCaller'
>

/** The caller's options a server's start takes; this Orca's own fields, and a lineage claim the
 *  caller made itself, stay here. */
export function serverStartOptions(params: StartParams) {
  const {
    from: _from,
    run: _run,
    on: _on,
    task: _task,
    deps: _deps,
    parent: _parent,
    chatLineage: _chatLineage,
    ...options
  } = params
  return options
}

/** One ID for the Task here and the start there, from the start's retry key, so a retry finds both. */
function adoptedTaskId(key: string): string {
  return `task_${createHash('sha256').update(`task\n${key}`).digest('hex').slice(0, 12)}`
}

const StartedOnServer = z.object({
  dispatchId: z.string().min(1),
  run: z.object({ id: z.string().min(1) }).optional(),
  agent: z.string().nullable().optional(),
  launch: z.unknown().optional(),
  state: z.string().optional()
})

/**
 * worker-start --on a server that owns its workers: the Task stays in this Orca's graph, and the
 * server starts an ordinary worker for it as the Run's coordinator. Synchronous, launch then
 * record: the Task is reserved for the server first, and becomes its attempt once it answers.
 */
export async function startRemoteOwnedWorker(
  runtime: OrcaRuntimeService,
  params: StartParams,
  ctx: StartContext,
  callerRequestId: string | undefined,
  workTarget?: ResolvedBotWorkTargetPlacement
): Promise<unknown> {
  if (params.terminal) {
    throw new OrchestrationError(
      'invalid_argument',
      '--terminal names a terminal on this Orca, so it cannot be used with --on. No effects were applied.',
      { effectsApplied: false }
    )
  }
  const {
    params: effectiveParams,
    workTarget: preparedWorkTarget,
    coordinator,
    bindRun,
    helperCreator,
    taskDeps,
    existingTask,
    withRun
  } = await prepareWorkerStart(params, ctx)
  params = effectiveParams
  const enforcedWorkTarget = workTarget ?? preparedWorkTarget
  const db = runtime.getOrchestrationDb()
  const server = await runtime.resolveOrchestrationWorkerServer(params.on!)
  assertBotWorkTargetPairingRevision(server, enforcedWorkTarget)
  // This caller's workspace is here, so a server's new-child nests under it across machines.
  const crossStoreParent =
    params.worktree === 'new-child'
      ? await resolveCrossMachineChildParent(runtime, params.from, ctx.orchestrationCaller)
      : undefined
  const lineage = await forwardedChatLineage(runtime, db, params, ctx.orchestrationCaller, server)
  const { run } = bindRun()
  // An older CLI sends no request ID; the start still runs, but a retry cannot find it.
  const forward = remoteForwardKey(runtime, ctx, params.from, callerRequestId ?? randomUUID())!
  const taskId = existingTask?.id ?? adoptedTaskId(forward.key)
  const budgets = resolveFederatedWorkerStartBudgets(params.timeoutMs)
  // Before any link is written: a Task an earlier pairing with this server placed is not reused there.
  refuseTaskOfClosedPairing(db, taskId, server)
  const link = openRemoteRunLink(db, run.id, server, (handle, type) =>
    runtime.notifyMessageArrived(handle, type)
  )
  const { task, nothingSent } = reserveRemotePlacement(db, {
    link,
    taskId,
    requestKey: forward.key,
    retryOf: params.retryOf,
    create: existingTask
      ? undefined
      : {
          spec: params.spec!,
          taskTitle: params.taskTitle,
          deps: taskDeps,
          parentId: params.parent,
          createdByTerminalHandle: coordinator?.terminalHandle ?? undefined,
          createdByPaneKey: coordinator?.paneKey ?? undefined,
          createdByRunGeneration: run.consumer_generation
        }
  })
  // Its queue has a reader from the start, so mail sent before the answer still comes home.
  runtime.ensureOrchestrationFederationRelay(run.id)
  const options = serverStartOptions(params)
  // Read before the wait: the server cannot tell a bot's worker from a person's, and the
  // coordinator's own Dispatch may settle while the server starts this one.
  const keepOpenByDefault = coordinatorKeepOpenByDefault(
    db,
    params.worktree,
    {
      orcaSessionId: coordinator?.orcaSessionId ?? null,
      creatorDispatchId: helperCreator?.id ?? null
    },
    (sessionId) => botOfSession(runtime.bots, sessionId) !== null
  )
  const startCard = prepareWorkerStartCard(runtime, ctx.orchestrationCaller)
  let receipt: unknown
  try {
    receipt = await callRemoteOwnedServer(runtime, link, {
      method: 'orchestration.workerStart',
      params: {
        ...options,
        // A retry names the server's existing Task, whose ordinary retry checks refuse a spec.
        ...(params.retryOf
          ? { task: task.id }
          : { spec: task.spec, ...(task.task_title ? { taskTitle: task.task_title } : {}) }),
        adoptTaskId: task.id,
        ...(crossStoreParent ? { crossStoreParent } : {}),
        ...lineage
      },
      timeoutMs: budgets.attachDeadlineMs,
      requestId: forward.key,
      whileLink: ['open']
    })
  } catch (error) {
    settleUnansweredStart(runtime, {
      conversationId: link.conversation_id,
      taskId,
      error,
      key: forward.key,
      createdByStart: !existingTask,
      nothingSent
    })
    throw inServerTerms(error, { server: server.name, forward })
  }
  const started = StartedOnServer.safeParse(receipt)
  if (started.success) {
    // The server's receipt names the agent in its launch, as a local start's does.
    const agent = started.data.agent ?? workerLaunchAgent(started.data.launch)
    const recorded = recordRemoteStart(db, {
      conversationId: link.conversation_id,
      taskId,
      dispatchId: started.data.dispatchId,
      requestKey: forward.key,
      peerRunId: started.data.run?.id,
      agent
    })
    if (!recorded) {
      // A reset already removed the reservation; a re-made pairing keeps it, so a later start of the Task there is refused here.
      throw new OrchestrationError(
        'run_not_found',
        `Run ${run.id} was reset, or its pairing with ${server.name} re-made, while this start was waiting, so this Orca records nothing for the worker it started there (Dispatch ${started.data.dispatchId}).`,
        { server: server.name }
      )
    }
    startCard({
      // As local and attached starts do: a start the server could not ready leaves no card.
      ready: started.data.state === 'ready',
      dispatchId: started.data.dispatchId,
      taskId: task.id,
      workerAddress: `dispatch:${started.data.dispatchId}`,
      task: task.spec
    })
  }
  const answer = inServerTerms(receipt, { server: server.name, forward })
  return withRun(
    answer && typeof answer === 'object'
      ? {
          ...answer,
          // This Orca's Run and Task; the server's own Run for them is named apart.
          taskId,
          runId: run.id,
          runCreated: bindRun().created,
          keepOpenByDefault,
          ...(started.data?.run ? { serverRunId: started.data.run.id } : {})
        }
      : answer
  )
}

/** What a start's failure says about its reservation: adopt the Dispatch it names, keep it for the server's queue to answer, or free it. */
function settleUnansweredStart(
  runtime: OrcaRuntimeService,
  start: {
    conversationId: string
    taskId: string
    key: string
    error: unknown
    createdByStart: boolean
    nothingSent: boolean
  }
): void {
  const db = runtime.getOrchestrationDb()
  const data = errorData(start.error)
  const named = typeof data?.dispatchId === 'string' ? data.dispatchId : undefined
  // An unknown outcome stays reserved: the queue item for any Dispatch the server created adopts it.
  const outcomeUnknown =
    (start.error instanceof OrchestrationError && start.error.code === 'operation_unknown') ||
    (serverNeverAnswered(start.error) && data?.effectsApplied !== false)
  if (named) {
    recordRemoteStart(db, {
      conversationId: start.conversationId,
      taskId: start.taskId,
      dispatchId: named,
      requestKey: start.key
    })
  } else if (!outcomeUnknown) {
    // The server's ordinary start refused it, which a start that had launched answers with a receipt.
    releaseRemotePlacement(db, start.taskId, start.key, { createdByStart: start.createdByStart })
  } else if (start.nothingSent && failedBeforeSending(start.error)) {
    markRemotePlacementNeverSent(db, start.taskId, start.key)
  }
}
