import type { FolderWorkspace } from '../../../../../../../../shared/folder-workspaces/folder-workspace-types'
import type { ResolvedBotWorkTargetPlacement } from '../../../../../../../../shared/agent-session/work-target/agent-session-work-target'
import { parseWorkspaceKey } from '../../../../../../../../shared/workspace/identity/workspace-scope'
import { assertManagedWorktreeMatchesTarget } from '../../../../../../../bots/bot-work-target-refusals'
import type { OrcaRuntimeService } from '../../../../../../orca-runtime'
import type { OrchestrationEntryCaller } from '../../../../../../orchestration/addressing/orchestration-caller-identity'
import { resolveDispatchCallerWorktreeId } from '../../../orchestration-caller-workspace'
import { resolveWorkerConfiguredAgentParams } from '../launch/worker-configured-agent-preflight'
import { probeWorkerOpenCodeModelLaunchSupport } from '../launch/worker-opencode-model-preflight'
import { prepareLocalWorkerStart } from '../launch/worker-start-validation'
import type { WorkerStartInput } from '../worker-start-input'
import { assertOrchestrationWorktreeCreationSupported } from './folder-worktree-placement'
import {
  resolveWorkerWorktreeCreationTarget,
  type WorkerWorktreeCreationTarget
} from './worker-worktree-creation'

/** Resolve agent config preflight and validated target placement for a local/SSH worker start. */
export async function prepareLocalWorkerPlacementAndLaunch(args: {
  runtime: OrcaRuntimeService
  params: WorkerStartInput
  callerSession?: OrchestrationEntryCaller
  requestedWorktree: string
  createsWorktree: boolean
  workTarget?: ResolvedBotWorkTargetPlacement
}): Promise<{
  agent: ReturnType<typeof prepareLocalWorkerStart>['agent']
  launch: ReturnType<typeof prepareLocalWorkerStart>['launch']
  creationTarget?: WorkerWorktreeCreationTarget
  managed?: Awaited<ReturnType<OrcaRuntimeService['showManagedTerminalWorkspace']>>
  selector?: string
  resolvedFolder?: FolderWorkspace
}> {
  const { runtime, params, callerSession, requestedWorktree, createsWorktree, workTarget } = args
  const coordinatorWorktreeId = await resolveDispatchCallerWorktreeId(
    runtime,
    params.from,
    callerSession
  )
  const existingWorktree =
    requestedWorktree === 'current' ? `id:${coordinatorWorktreeId}` : requestedWorktree
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
  const launchParams = await resolveWorkerConfiguredAgentParams(runtime, params, async () =>
    createsWorktree
      ? { repo: (await resolveCreation()).repoSelector }
      : { worktree: existingWorktree }
  )
  const openCodeModelLaunchSupported =
    !createsWorktree && launchParams.agent === 'opencode' && launchParams.model
      ? await probeWorkerOpenCodeModelLaunchSupport(runtime, launchParams, {
          worktree: existingWorktree
        })
      : false
  const { agent, launch } = prepareLocalWorkerStart({
    params: launchParams,
    createsWorktree,
    runtime,
    openCodeModelLaunchSupported
  })
  if (createsWorktree) {
    const creationTarget = await resolveCreation()
    await assertOrchestrationWorktreeCreationSupported({
      runtime,
      repoSelector: creationTarget.repoSelector,
      existingPlacement: 'current or an exact existing folder workspace'
    })
    return { agent, launch, creationTarget }
  }
  const managed = await runtime.showManagedTerminalWorkspace(
    existingWorktree,
    workTarget?.targetHostId
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
  return { agent, launch, managed, selector, ...(resolvedFolder ? { resolvedFolder } : {}) }
}
