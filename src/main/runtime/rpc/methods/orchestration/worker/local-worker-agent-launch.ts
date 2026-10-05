import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationSessionCaller } from '../../../../orchestration/orchestration-caller-identity'
import { resolveDispatchCallerWorktreeId } from '../../orchestration-caller-workspace'
import { probeWorkerOpenCodeModelLaunchSupport } from './worker-opencode-model-preflight'
import { resolveWorkerConfiguredAgentParams } from './worker-configured-agent-preflight'
import { prepareLocalWorkerStart } from './worker-start-validation'
import type { WorkerStartInput } from './worker-start-schema'

/** The worker's agent and launch, after its configured agent and any OpenCode model are checked on
 *  the host that will run it. */
export async function prepareLocalWorkerAgentLaunch(args: {
  runtime: OrcaRuntimeService
  params: WorkerStartInput
  callerSession: OrchestrationSessionCaller | undefined
  createsWorktree: boolean
  requestedWorktree: string
}) {
  const { runtime, params, callerSession, createsWorktree, requestedWorktree } = args
  const launchParams = await resolveWorkerConfiguredAgentParams(runtime, params, async () => {
    const callerWorkspaceId = await resolveDispatchCallerWorktreeId(
      runtime,
      params.from,
      callerSession
    )
    const parent = createsWorktree
      ? await runtime.showManagedWorktree(`id:${callerWorkspaceId}`)
      : undefined
    return createsWorktree
      ? { repo: params.repo ?? parent?.repoId }
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

  return prepareLocalWorkerStart({
    params: launchParams,
    createsWorktree,
    runtime,
    openCodeModelLaunchSupported
  })
}
