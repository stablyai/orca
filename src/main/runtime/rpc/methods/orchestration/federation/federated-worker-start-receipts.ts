import type { OrchestrationWorkerLaunchReceipt } from '../worker/worker-launch-preferences'
import type { RemoteFederatedWorkerStartReceipt } from './federated-attach-receipt'

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
  agentSelection?: { agent: string; source: string; projectId?: string; projectName?: string }
) {
  return {
    taskId,
    dispatchId: worker.dispatch_id,
    state: 'outcome_unknown',
    stage: worker.stage,
    server: { name: serverName },
    launch,
    ...(agentSelection ? { agentSelection } : {}),
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

export function federatedFailureReceipt({
  worker,
  runId,
  taskId,
  server,
  launch,
  agentSelection,
  remote
}: {
  worker: Parameters<typeof federatedUnknownReceipt>[0]
  runId: string
  taskId: string
  server: { environmentId: string; name: string }
  launch: OrchestrationWorkerLaunchReceipt
  agentSelection?: Parameters<typeof federatedUnknownReceipt>[4]
  remote?: Pick<RemoteFederatedWorkerStartReceipt, 'setup' | 'effects' | 'residualResources'>
}) {
  return {
    runId,
    taskId,
    dispatchId: worker.dispatch_id,
    state: worker.state,
    stage: worker.stage,
    server: { environmentId: server.environmentId, name: server.name },
    failedStage: worker.stage,
    lastError: worker.last_error,
    ...(remote ? { setup: remote.setup } : {}),
    launch,
    ...(agentSelection ? { agentSelection } : {}),
    effects: remote?.effects ?? [],
    residualResources: remote?.residualResources ?? []
  }
}
