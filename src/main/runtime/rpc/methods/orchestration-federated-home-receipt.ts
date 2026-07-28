import type { OrchestrationDb } from '../../orchestration/db'

type RemoteUnknownReceipt = {
  runtimeEpoch: string
  worktreeId?: string
  terminalHandle?: string
  setup?: { state: string }
  effects?: unknown[]
  residualResources?: unknown[]
  failedStage?: string
  lastError?: string
}

export function persistFederatedUnknownReceipt(args: {
  db: OrchestrationDb
  dispatchId: string
  taskId: string
  serverName: string
  remote: RemoteUnknownReceipt
}): unknown {
  const { db, dispatchId, remote } = args
  db.updateFederatedDispatchResources({
    dispatchId,
    remoteRuntimeEpoch: remote.runtimeEpoch,
    worktreeId: remote.worktreeId,
    terminalHandle: remote.terminalHandle
  })
  db.recordWorkerStage({
    dispatchId,
    stage: remote.failedStage ?? 'remote_attach',
    worktreeId: remote.worktreeId,
    terminalHandle: remote.terminalHandle,
    setupState: remote.setup?.state,
    effects: remote.effects,
    residualResources: remote.residualResources
  })
  const worker = db.markWorkerStartUnknown(
    dispatchId,
    remote.failedStage ?? 'remote_attach',
    remote.lastError ?? 'The worker server reported an unknown start outcome.'
  )
  return federatedUnknownReceipt(worker, args.taskId, args.serverName, remote.setup)
}

export function federatedUnknownReceipt(
  worker: ReturnType<OrchestrationDb['markWorkerStartUnknown']>,
  taskId: string,
  serverName: string,
  setup?: { state: string }
): unknown {
  return {
    taskId,
    dispatchId: worker.dispatch_id,
    state: 'outcome_unknown',
    stage: worker.stage,
    server: { name: serverName },
    failedStage: worker.stage,
    lastError: worker.last_error,
    setup,
    effects: JSON.parse(worker.effects) as unknown[],
    residualResources: JSON.parse(worker.residual_resources) as unknown[],
    nextCommands: [
      `orca orchestration worker-show --dispatch ${worker.dispatch_id} --json`,
      `orca orchestration worker-abandon --dispatch ${worker.dispatch_id} --json`
    ]
  }
}
