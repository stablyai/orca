import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import {
  resolveFederatedWorkerLaunchReceipt,
  type OrchestrationWorkerLaunchReceipt
} from './orchestration-worker-launch-preferences'

export type RemoteStartReceipt = {
  dispatchId: string
  state: string
  runtimeEpoch: string
  worktreeId?: string
  terminalHandle?: string
  setup?: { state: string }
  launch?: OrchestrationWorkerLaunchReceipt
  effects?: unknown[]
  residualResources?: unknown[]
  failedStage?: string
  lastError?: string
}

type FederatedStartResultArgs = {
  db: OrchestrationDb
  runtime: OrcaRuntimeService
  runId: string
  taskId: string
  dispatchId: string
  server: { environmentId: string; name: string }
  requestedLaunch: OrchestrationWorkerLaunchReceipt
  timeoutMs: number
}

export function finalizeFederatedWorkerStart(
  args: FederatedStartResultArgs & { remote: RemoteStartReceipt }
): unknown {
  const { db, runtime, remote } = args
  if (remote.dispatchId !== args.dispatchId) {
    throw new OrchestrationError(
      'resource_server_mismatch',
      'The worker server returned a different Dispatch attachment.'
    )
  }
  const launch = resolveFederatedWorkerLaunchReceipt(
    remote.launch,
    args.requestedLaunch,
    remote.state === 'ready'
  )
  if (remote.state === 'ready' && remote.worktreeId && remote.terminalHandle) {
    db.updateFederatedDispatchResources({
      dispatchId: args.dispatchId,
      remoteRuntimeEpoch: remote.runtimeEpoch,
      worktreeId: remote.worktreeId,
      terminalHandle: remote.terminalHandle
    })
    db.recordWorkerStage({
      dispatchId: args.dispatchId,
      stage: 'remote_input_accepted',
      worktreeId: remote.worktreeId,
      terminalHandle: remote.terminalHandle,
      setupState: remote.setup?.state,
      effects: remote.effects,
      residualResources: remote.residualResources
    })
    const readyWorker = db.markWorkerDispatchReady(args.dispatchId)
    runtime.ensureOrchestrationFederationRelay(args.runId)
    return {
      runId: args.runId,
      taskId: args.taskId,
      dispatchId: args.dispatchId,
      state: 'ready',
      stage: readyWorker.stage,
      server: args.server,
      setup: remote.setup,
      launch,
      timeoutMs: args.timeoutMs,
      effects: remote.effects ?? [],
      residualResources: remote.residualResources ?? []
    }
  }
  if (remote.state === 'outcome_unknown') {
    const worker = db.markWorkerStartUnknown(
      args.dispatchId,
      remote.failedStage ?? 'remote_attach',
      remote.lastError ?? 'The worker server reported an unknown start outcome.'
    )
    return federatedUnknownReceipt(worker, args.taskId, args.server.name, launch)
  }
  const worker = db.failWorkerStart(
    args.dispatchId,
    remote.failedStage ?? 'remote_attach',
    remote.lastError ?? `The worker server returned ${remote.state}.`
  )
  return {
    runId: args.runId,
    taskId: args.taskId,
    dispatchId: args.dispatchId,
    state: worker.state,
    stage: worker.stage,
    server: args.server,
    failedStage: worker.stage,
    lastError: worker.last_error,
    setup: remote.setup,
    launch,
    effects: remote.effects ?? [],
    residualResources: remote.residualResources ?? []
  }
}

export function failFederatedWorkerStart(
  args: FederatedStartResultArgs & { error: unknown; resumeSourceDispatchId?: string }
): unknown {
  const reason = args.error instanceof Error ? args.error.message : String(args.error)
  if (args.error instanceof OrchestrationError && isKnownRemoteStartFailure(args.error.code)) {
    const worker = args.db.failWorkerStart(args.dispatchId, 'remote_attach', reason)
    if (args.resumeSourceDispatchId) {
      args.db.releaseUnacceptedWorkerResumeSourceClaim({
        dispatchId: args.dispatchId,
        sourceDispatchId: args.resumeSourceDispatchId
      })
    }
    return {
      runId: args.runId,
      taskId: args.taskId,
      dispatchId: args.dispatchId,
      state: worker.state,
      stage: worker.stage,
      server: args.server,
      failedStage: worker.stage,
      lastError: worker.last_error,
      launch: args.requestedLaunch,
      effects: [],
      residualResources: []
    }
  }
  const worker = args.db.markWorkerStartUnknown(args.dispatchId, 'remote_attach', reason)
  return federatedUnknownReceipt(worker, args.taskId, args.server.name, args.requestedLaunch)
}

function isKnownRemoteStartFailure(code: string): boolean {
  return [
    'invalid_argument',
    'agent_unconfigured',
    'worktree_not_found_on_server',
    'terminal_worktree_mismatch',
    'capability_unsupported',
    'resume_agent_unsupported',
    'resume_checkpoint_claimed',
    'resume_checkpoint_mismatch',
    'resume_checkpoint_missing',
    'resume_dispatch_not_found',
    'resume_host_mismatch',
    'resume_ownership_mismatch',
    'resume_provider_mismatch',
    'resume_session_conflict',
    'resume_source_active',
    'resume_worktree_unavailable'
  ].includes(code)
}

function federatedUnknownReceipt(
  worker: { dispatch_id: string; state: string; stage: string; last_error: string | null },
  taskId: string,
  serverName: string,
  launch: OrchestrationWorkerLaunchReceipt
): unknown {
  return {
    taskId,
    dispatchId: worker.dispatch_id,
    state: 'outcome_unknown',
    stage: worker.stage,
    server: { name: serverName },
    launch,
    failedStage: worker.stage,
    lastError: worker.last_error,
    effects: [],
    residualResources: [],
    nextCommands: [
      `orca orchestration worker-show --dispatch ${worker.dispatch_id} --json`,
      `orca orchestration worker-abandon --dispatch ${worker.dispatch_id} --json`
    ]
  }
}
