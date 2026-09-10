import type { TuiAgent } from '../../../../shared/tui-agent'
import { buildMaestroTerminalLeaseTitle } from '../../../../shared/maestro-terminal-lease'
import { parseWorkspaceKey, worktreeWorkspaceKey } from '../../../../shared/workspace-scope'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { assertOrchestrationWorktreeCreationSupported } from './orchestration/worker/folder-worktree-placement'
import {
  isAttemptBoundAttachStart,
  type FederationAttachStartInput
} from './orchestration/federation/federation-start-schema'
import type { prepareFederationAttachmentWorkerStart } from './orchestration/worker/worker-start-validation'

export type OrchestrationMutation = {
  callerFingerprint: string
  requestId: string
  method: string
  payloadHash: string
}

type PreparedWorkerStart = ReturnType<typeof prepareFederationAttachmentWorkerStart>

type FederatedAttachmentRuntimeArgs = {
  params: FederationAttachStartInput
  runtime: OrcaRuntimeService
  orchestrationMutation: OrchestrationMutation
  createsWorktree: boolean
  agent: PreparedWorkerStart['agent']
  launch: PreparedWorkerStart['launch']
}

export async function prepareFederatedAttachmentRuntime({
  params,
  runtime,
  orchestrationMutation,
  createsWorktree,
  agent,
  launch
}: FederatedAttachmentRuntimeArgs) {
  if (createsWorktree) {
    await assertOrchestrationWorktreeCreationSupported({
      runtime,
      repoSelector: params.repo as string,
      existingPlacement: 'an exact existing folder workspace'
    })
  }
  const preflightWorktree = createsWorktree
    ? await (async () => {
        const repo = await runtime.showRepo(params.repo as string)
        return { id: repo.id }
      })()
    : await runtime.showManagedTerminalWorkspace(params.worktree)
  const preflightExecutable = runtime.preflightWorktreeManagedCliExecutable(preflightWorktree)

  const db = runtime.getOrchestrationDb()
  db.createRemoteDispatchAttachment({
    dispatchId: params.dispatchId,
    taskId: params.taskId,
    homePeerFingerprint: orchestrationMutation.callerFingerprint,
    protocolVersion: params.protocolVersion,
    runtimeEpoch: runtime.getRuntimeId(),
    depth: params.depth,
    mutationReceipt: orchestrationMutation
  })
  const attemptBound = isAttemptBoundAttachStart(params) ? params : null
  const runId = attemptBound?.runId ?? params.dispatchId
  const leaseTitle = buildMaestroTerminalLeaseTitle({
    role: 'worker',
    runId,
    taskId: params.taskId,
    agent: agent as TuiAgent
  })
  const workerLease = attemptBound
    ? db.reserveMaestroTerminalLease({
        requestId: `federated-worker:${params.dispatchId}`,
        executionHostId: runtime.getRuntimeId(),
        workspaceKey: parseWorkspaceKey(params.worktree)
          ? params.worktree
          : params.worktree === 'new-top-level'
            ? `pending:${params.dispatchId}`
            : worktreeWorkspaceKey(params.worktree),
        runId,
        taskId: params.taskId,
        attemptId: attemptBound.attemptId,
        coordinatorGeneration: attemptBound.coordinatorGeneration,
        role: 'worker',
        title: leaseTitle,
        launchProfile: {
          agent: agent as TuiAgent,
          model: launch.receipt.effective?.model ?? null,
          effort: launch.receipt.effective?.effort ?? null,
          permissionMode: launch.receipt.effective?.permissionMode ?? 'default',
          routeRef: `federation:${orchestrationMutation.callerFingerprint}`
        },
        spawnedBy: orchestrationMutation.callerFingerprint,
        ownerPrincipal: `dispatch:${params.dispatchId}`,
        retentionPolicy: params.terminal ? 'retain' : 'auto_release'
      })
    : null

  return { attemptBound, db, leaseTitle, preflightExecutable, runId, workerLease }
}
