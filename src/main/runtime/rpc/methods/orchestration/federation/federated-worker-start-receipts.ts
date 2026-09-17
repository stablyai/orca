import type { OrchestrationWorkerLaunchReceipt } from '../worker/worker-launch-preferences'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { RemoteFederatedWorkerStartReceipt } from './federated-attach-receipt'

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
  prompt?: unknown
  failedStage?: string
  lastError?: string
}

export function isKnownRemoteStartFailure(code: string): boolean {
  return [
    'invalid_argument',
    'agent_unconfigured',
    'worktree_not_found_on_server',
    'terminal_worktree_mismatch',
    'capability_unsupported'
  ].includes(code)
}

export function federatedUnknownReceipt(
  worker: { dispatch_id: string; state: string; stage: string; last_error: string | null },
  taskId: string,
  serverName: string,
  launch: OrchestrationWorkerLaunchReceipt,
  details?: {
    setup?: { state: string }
    terminalHandle?: string
    effects?: unknown[]
    residualResources?: unknown[]
  }
): unknown {
  return {
    taskId,
    dispatchId: worker.dispatch_id,
    state: 'outcome_unknown',
    stage: worker.stage,
    server: { name: serverName },
    launch,
    ...(details?.setup ? { setup: details.setup } : {}),
    ...(details?.terminalHandle ? { terminalHandle: details.terminalHandle } : {}),
    ...(details?.effects ? { effects: details.effects } : { effects: [] }),
    ...(details?.residualResources
      ? { residualResources: details.residualResources }
      : { residualResources: [] }),
    failedStage: worker.stage,
    lastError: worker.last_error,
    nextCommands: [
      `orca orchestration worker-show --dispatch ${worker.dispatch_id} --json`,
      ...(details?.terminalHandle
        ? [`orca terminal read --terminal ${details.terminalHandle} --screen`]
        : []),
      `orca orchestration worker-abandon --dispatch ${worker.dispatch_id} --json`
    ]
  }
}

export function preserveFederatedWorkerStartUnknown(args: {
  db: OrchestrationDb
  dispatchId: string
  taskId: string
  serverName: string
  launch: OrchestrationWorkerLaunchReceipt
  remote: RemoteFederatedWorkerStartReceipt
}): unknown {
  const stage = args.remote.failedStage ?? args.remote.stage ?? 'remote_attach'
  if (args.remote.runtimeEpoch && args.remote.worktreeId && args.remote.terminalHandle) {
    args.db.updateFederatedDispatchResources({
      dispatchId: args.dispatchId,
      remoteRuntimeEpoch: args.remote.runtimeEpoch,
      worktreeId: args.remote.worktreeId,
      terminalHandle: args.remote.terminalHandle
    })
  }
  args.db.recordWorkerStage({
    dispatchId: args.dispatchId,
    stage,
    worktreeId: args.remote.worktreeId,
    terminalHandle: args.remote.terminalHandle,
    setupState: args.remote.setup?.state,
    effects: args.remote.effects,
    residualResources: args.remote.residualResources
  })
  const worker = args.db.markWorkerStartUnknown(
    args.dispatchId,
    stage,
    args.remote.lastError ?? 'The worker server reported an unknown start outcome.',
    args.remote.effects
  )
  return federatedUnknownReceipt(worker, args.taskId, args.serverName, args.launch, {
    setup: args.remote.setup,
    terminalHandle: args.remote.terminalHandle,
    effects: args.remote.effects,
    residualResources: args.remote.residualResources
  })
}
