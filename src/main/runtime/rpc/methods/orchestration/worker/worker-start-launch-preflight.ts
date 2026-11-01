import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationSessionCaller } from '../../../../orchestration/orchestration-caller-identity'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { resolveDispatchCallerWorktreeId } from '../../orchestration-caller-workspace'
import {
  resolveWorkerStartModeOnHost,
  type WorkerStartModeReceipt
} from '../../orchestration-worker-start-mode'
import type { WorkerStartInput } from './worker-start-schema'
import { resolveWorkerConfiguredAgentParams } from './worker-configured-agent-preflight'
import { probeWorkerOpenCodeModelLaunchSupport } from './worker-opencode-model-preflight'
import { preflightStructuredWorkerFast } from './worker-structured-fast-preflight'
import { prepareLocalWorkerStart } from './worker-start-validation'
import type { WorkerWorktreeCreationTarget } from './worker-worktree-creation'

export async function preflightLocalWorkerStartLaunch(args: {
  params: WorkerStartInput
  runtime: OrcaRuntimeService
  callerSession?: OrchestrationSessionCaller
  requestedWorktree: string
  createsWorktree: boolean
  creationTargetFor: (callerWorktreeId: string) => Promise<WorkerWorktreeCreationTarget>
  mode: WorkerStartModeReceipt
}) {
  const { params, runtime, callerSession, requestedWorktree, createsWorktree, mode } = args
  const launchParams = await resolveWorkerConfiguredAgentParams(runtime, params, async () => {
    const callerWorkspaceId = await resolveDispatchCallerWorktreeId(
      runtime,
      params.from,
      callerSession
    )
    return createsWorktree
      ? { repo: (await args.creationTargetFor(callerWorkspaceId)).repoSelector }
      : {
          worktree: requestedWorktree === 'current' ? `id:${callerWorkspaceId}` : requestedWorktree
        }
  })
  let openCodeModelLaunchSupported = false
  if (!createsWorktree && launchParams.agent === 'opencode' && launchParams.model) {
    const callerWorkspaceId = await resolveDispatchCallerWorktreeId(
      runtime,
      params.from,
      callerSession
    )
    openCodeModelLaunchSupported = await probeWorkerOpenCodeModelLaunchSupport(
      runtime,
      launchParams,
      { worktree: requestedWorktree === 'current' ? `id:${callerWorkspaceId}` : requestedWorktree }
    )
  }

  let fastWorkspace: Awaited<ReturnType<typeof runtime.showManagedTerminalWorkspace>> | undefined
  let fastWorkerMode: WorkerStartModeReceipt | undefined
  let structuredFastModeSupported = false
  let structuredFastServiceTier: string | undefined
  if (
    launchParams.fastMode !== undefined &&
    (launchParams.agent === 'claude' || launchParams.agent === 'codex') &&
    mode.mode === 'structured'
  ) {
    if (createsWorktree) {
      throw new OrchestrationError(
        'capability_unsupported',
        'Claude and Codex Fast need an existing workspace with a verified model catalog. No effects were applied.',
        { effectsApplied: false }
      )
    }
    const callerWorkspaceId = await resolveDispatchCallerWorktreeId(
      runtime,
      params.from,
      callerSession
    )
    fastWorkspace = await runtime.showManagedTerminalWorkspace(
      requestedWorktree === 'current' ? `id:${callerWorkspaceId}` : requestedWorktree
    )
    fastWorkerMode = await resolveWorkerStartModeOnHost(
      runtime,
      mode,
      fastWorkspace.id,
      launchParams.agent
    )
    if (fastWorkerMode.mode === 'structured') {
      structuredFastServiceTier = await preflightStructuredWorkerFast({
        runtime,
        agent: launchParams.agent,
        model: launchParams.model,
        fastMode: launchParams.fastMode,
        worktree: `id:${fastWorkspace.id}`
      })
      structuredFastModeSupported = true
    }
  }

  const prepared = prepareLocalWorkerStart({
    params: launchParams,
    createsWorktree,
    runtime,
    openCodeModelLaunchSupported,
    structuredFastModeSupported,
    structuredFastServiceTier
  })
  return { ...prepared, fastWorkspace, fastWorkerMode }
}
