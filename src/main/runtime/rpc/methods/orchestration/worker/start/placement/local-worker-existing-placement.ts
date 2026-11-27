import type { FolderWorkspace } from '../../../../../../../../shared/folder-workspaces/folder-workspace-types'
import type { ResolvedBotWorkTargetPlacement } from '../../../../../../../../shared/agent-session/work-target/agent-session-work-target'
import { parseWorkspaceKey } from '../../../../../../../../shared/workspace/identity/workspace-scope'
import { assertManagedWorktreeMatchesTarget } from '../../../../../../../bots/bot-work-target-refusals'
import type { OrcaRuntimeService } from '../../../../../../orca-runtime'
import type { OrchestrationEntryCaller } from '../../../../../../orchestration/addressing/orchestration-caller-identity'
import type { AgentLaunchModeReceipt as WorkerStartModeReceipt } from '../../../../../../../../shared/agent-launch/contracts/agent-launch-intent'
import type { TuiAgent } from '../../../../../../../../shared/agent-launch/catalog/tui-agent'
import { runtimeRepoSelectorText } from '../../../../../../workspaces/catalog/runtime-repo-selector'
import { preflightWorkerAgentOnHost } from '../launch/worker-agent-host-preflight'
import { resolveDispatchCallerWorktreeId } from '../../../orchestration-caller-workspace'
import { resolveLocalWorkerStartLaunch } from '../launch/worker-opencode-model-preflight'
import type { WorkerStartInput } from '../worker-start-input'
import {
  refuseUnmatchedWorkerSelector,
  workerStartTargetLabel
} from '../worker-start-selector-refusal'
import { resolveExistingWorkerWorkspace } from './folder-worktree-placement'
import {
  resolveWorkerWorktreeCreationTarget,
  type WorkerWorktreeCreationTarget
} from './worker-worktree-creation'

/** Resolve agent config preflight and validated target placement for a local/SSH worker start. */
export async function prepareLocalWorkerPlacementAndLaunch(args: {
  runtime: OrcaRuntimeService
  params: WorkerStartInput
  rawParams: WorkerStartInput
  callerSession?: OrchestrationEntryCaller
  requestedWorktree: string
  createsWorktree: boolean
  workTarget?: ResolvedBotWorkTargetPlacement
}): Promise<{
  agent: Awaited<ReturnType<typeof resolveLocalWorkerStartLaunch>>['agent']
  launch: Awaited<ReturnType<typeof resolveLocalWorkerStartLaunch>>['launch']
  retryLaunchWarning?: string
  creationTarget?: WorkerWorktreeCreationTarget
  managed?: Awaited<ReturnType<OrcaRuntimeService['showManagedTerminalWorkspace']>>
  selector?: string
  resolvedFolder?: FolderWorkspace
}> {
  const {
    runtime,
    params,
    rawParams,
    callerSession,
    requestedWorktree,
    createsWorktree,
    workTarget
  } = args
  const coordinatorWorktreeId = await refuseUnmatchedWorkerSelector(
    { flag: '--from', value: params.from },
    () => resolveDispatchCallerWorktreeId(runtime, params.from, callerSession)
  )
  const existingWorktree =
    requestedWorktree === 'current' ? `id:${coordinatorWorktreeId}` : requestedWorktree
  const targetLabel = workerStartTargetLabel({ ...rawParams, createsWorktree, requestedWorktree })
  const resolveCreation = () =>
    resolveWorkerWorktreeCreationTarget({
      runtime,
      requestedWorktree,
      repo: params.repo,
      callerWorktreeId: coordinatorWorktreeId,
      crossStoreParent: params.crossStoreParent,
      ...(workTarget?.targetHostId ? { targetHostId: workTarget.targetHostId } : {}),
      ...(workTarget?.mode === 'new-top-level' ? { suppressBotHomeParent: true as const } : {})
    })
  const {
    agent,
    launch,
    warning: retryLaunchWarning
  } = await resolveLocalWorkerStartLaunch({
    params,
    createsWorktree,
    existingWorktree,
    targetLabel,
    runtime,
    resolveTarget: async () =>
      createsWorktree
        ? { repo: (await resolveCreation()).repoSelector }
        : { worktree: existingWorktree }
  })
  if (createsWorktree) {
    const creationTarget = await resolveCreation()
    await refuseUnmatchedWorkerSelector(targetLabel, () =>
      resolveExistingWorkerWorkspace(runtime, creationTarget, existingWorktree)
    )
    return {
      agent,
      launch,
      ...(retryLaunchWarning ? { retryLaunchWarning } : {}),
      creationTarget
    }
  }
  const managed = await refuseUnmatchedWorkerSelector(targetLabel, () =>
    runtime.showManagedTerminalWorkspace(existingWorktree, workTarget?.targetHostId)
  )
  if (workTarget) {
    assertManagedWorktreeMatchesTarget(managed, workTarget)
  }
  const selector = managed.identity?.key ? `identity:${managed.identity.key}` : `id:${managed.id}`
  const resolvedFolder =
    workTarget?.targetHostId && parseWorkspaceKey(managed.id)?.type === 'folder'
      ? runtime.resolveManagedFolderWorkspace?.(existingWorktree, workTarget.targetHostId)
          ?.workspace
      : undefined
  return {
    agent,
    launch,
    ...(retryLaunchWarning ? { retryLaunchWarning } : {}),
    managed,
    selector,
    ...(resolvedFolder ? { resolvedFolder } : {})
  }
}

/** Preflight launch mode and agent availability using the resolved worktree selector or creation repo. */
export function preflightLocalWorkerMode(
  runtime: OrcaRuntimeService,
  mode: WorkerStartModeReceipt,
  prepared: {
    agent: TuiAgent | undefined
    managed?: { id: string; repoId: string }
    selector?: string
    creationTarget?: WorkerWorktreeCreationTarget
  },
  terminal?: string
): Promise<WorkerStartModeReceipt> {
  return preflightWorkerAgentOnHost({
    runtime,
    mode,
    agent: prepared.agent,
    resolvedWorktree: prepared.managed
      ? { id: prepared.selector ?? prepared.managed.id, repoId: prepared.managed.repoId }
      : undefined,
    creationTarget: prepared.creationTarget
      ? { repoSelector: runtimeRepoSelectorText(prepared.creationTarget.repoSelector) }
      : undefined,
    terminal
  })
}
