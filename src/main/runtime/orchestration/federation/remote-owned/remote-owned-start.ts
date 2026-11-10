import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { WorkerStartParams } from '../../../../../shared/rpc-contract/orchestration-worker-start-params'
import { ORCHESTRATION_REMOTE_OWNED_WORKERS_RUNTIME_CAPABILITY } from '../../../../../shared/orchestration/orchestration-runtime-capabilities'
import { ORCHESTRATION_CONTRACT_PREFLIGHT_TIMEOUT_MS } from '../../../../../shared/orchestration/orchestration-timing-budgets'
import type { RuntimeStatus } from '../../../../../shared/runtime-session-contracts'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { RpcContext } from '../../../rpc/core'
import { prepareWorkerStart } from '../../../rpc/methods/orchestration/worker/workers'
import { resolveFederatedWorkerStartBudgets } from '../../../rpc/methods/orchestration/worker/worker-start-budgets'
import { OrchestrationError } from '../../orchestration-error'
import { prepareWorkerStartCard } from '../../workers/launch/worker-start-card'
import { getOrchestrationPeerCapabilityCache } from '../orchestration-peer-capability-cache'
import type { OrchestrationWorkerServer } from '../environment-transport'
import {
  markRemoteStartOutcomeUnknown,
  recordRemoteStart,
  releaseRemotePlacement,
  reserveRemotePlacement
} from '../../db/remote-owned/remote-placements'
import { openRemoteRunLink } from '../../db/remote-owned/remote-run-links'
import { callRemoteOwnedServer } from './remote-owned-calls'
import { remoteForwardKey } from './remote-forward-caller'
import { errorData, inServerTerms, serverNeverAnswered } from './remote-owned-answers'

type StartParams = z.infer<typeof WorkerStartParams>
type StartContext = Pick<
  RpcContext,
  'runtime' | 'orchestrationCompatibilityEvidence' | 'orchestrationCaller'
>

/** Whether the server runs the workers placed on it as its own; an older one keeps today's remote attachments. */
export async function serverOwnsPlacedWorkers(
  runtime: OrcaRuntimeService,
  server: OrchestrationWorkerServer
): Promise<boolean> {
  const decision = await getOrchestrationPeerCapabilityCache(runtime).resolve({
    peerFingerprint: server.peerFingerprint,
    expectedRuntimeEpoch: null,
    capability: ORCHESTRATION_REMOTE_OWNED_WORKERS_RUNTIME_CAPABILITY,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: status.get answers RuntimeStatus; the cache reads only its capabilities and runtime ID.
    probe: async () =>
      (await runtime.callOrchestrationWorkerServer(
        server.environmentId,
        'status.get',
        undefined,
        ORCHESTRATION_CONTRACT_PREFLIGHT_TIMEOUT_MS,
        undefined,
        { expectedEnvironmentPairingRevision: server.pairingRevision }
      )) as RuntimeStatus
  })
  return decision.supported
}

/** One ID for the Task here and the start there, from the start's retry key, so a retry finds both. */
function adoptedTaskId(key: string): string {
  return `task_${createHash('sha256').update(`task\n${key}`).digest('hex').slice(0, 12)}`
}

const StartedOnServer = z.object({
  dispatchId: z.string().min(1),
  run: z.object({ id: z.string().min(1) }).optional(),
  agent: z.string().nullable().optional()
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
  callerRequestId: string | undefined
): Promise<unknown> {
  if (params.terminal) {
    throw new OrchestrationError(
      'invalid_argument',
      '--terminal names a terminal on this Orca, so it cannot be used with --on. No effects were applied.',
      { effectsApplied: false }
    )
  }
  const { coordinator, bindRun, taskDeps, existingTask, withRun } = await prepareWorkerStart(
    params,
    ctx
  )
  const db = runtime.getOrchestrationDb()
  const server = runtime.resolveOrchestrationWorkerServer(params.on!)
  const { run } = bindRun()
  // An older CLI sends no request ID; the start still runs, but a retry cannot find it.
  const forward = remoteForwardKey(runtime, ctx, params.from, callerRequestId ?? randomUUID())!
  const taskId = existingTask?.id ?? adoptedTaskId(forward.key)
  const budgets = resolveFederatedWorkerStartBudgets(params.timeoutMs)
  const link = openRemoteRunLink(db, run.id, server)
  const { task } = reserveRemotePlacement(db, {
    link,
    taskId,
    requestKey: forward.key,
    runtimeId: runtime.getRuntimeId(),
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
  const {
    from: _from,
    run: _run,
    on: _on,
    task: _task,
    deps: _deps,
    parent: _parent,
    ...options
  } = params
  let receipt: unknown
  try {
    receipt = await callRemoteOwnedServer(runtime, link, {
      method: 'orchestration.workerStart',
      params: {
        ...options,
        spec: task.spec,
        ...(task.task_title ? { taskTitle: task.task_title } : {}),
        adoptTaskId: task.id
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
      key: forward.key
    })
    throw inServerTerms(error, forward, server.name)
  }
  const started = StartedOnServer.safeParse(receipt)
  if (started.success) {
    recordRemoteStart(db, {
      conversationId: link.conversation_id,
      taskId,
      dispatchId: started.data.dispatchId,
      requestKey: forward.key,
      peerRunId: started.data.run?.id,
      agent: started.data.agent ?? null
    })
    prepareWorkerStartCard(
      runtime,
      ctx.orchestrationCaller
    )({
      dispatchId: started.data.dispatchId,
      workerAddress: `dispatch:${started.data.dispatchId}`,
      task: task.spec,
      agent: null
    })
  }
  const answer = inServerTerms(receipt, forward, server.name)
  return withRun(
    answer && typeof answer === 'object'
      ? {
          ...answer,
          // This Orca's Run and Task; the server's own Run for them is named apart.
          taskId,
          runId: run.id,
          runCreated: bindRun().created,
          ...(started.data?.run ? { serverRunId: started.data.run.id } : {})
        }
      : answer
  )
}

/** What a start's failure says about its reservation: adopt the Dispatch it names, keep it for the orphan lookup, or free it. */
function settleUnansweredStart(
  runtime: OrcaRuntimeService,
  start: { conversationId: string; taskId: string; key: string; error: unknown }
): void {
  const db = runtime.getOrchestrationDb()
  const data = errorData(start.error)
  const named = typeof data?.dispatchId === 'string' ? data.dispatchId : undefined
  if (named) {
    recordRemoteStart(db, {
      conversationId: start.conversationId,
      taskId: start.taskId,
      dispatchId: named,
      requestKey: start.key
    })
  } else if (serverNeverAnswered(start.error) && data?.effectsApplied !== false) {
    markRemoteStartOutcomeUnknown(db, start.taskId, start.key)
  } else if (
    !(start.error instanceof OrchestrationError && start.error.code === 'operation_unknown')
  ) {
    // The server's ordinary start refused it, which a start that had launched answers with a receipt.
    releaseRemotePlacement(db, start.taskId, start.key)
  }
}
