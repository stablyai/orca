import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { OrchestrationSessionCaller } from '../../../../orchestration/orchestration-caller-identity'
import { resolveDispatchCallerWorktreeId } from '../../orchestration-caller-workspace'
import {
  resolveWorkerConfiguredAgentParams,
  resolveWorkerDefaultAgentParams
} from './worker-configured-agent-preflight'
import { probeWorkerOpenCodeModelLaunchSupport } from './worker-opencode-model-preflight'
import type { WorkerStartInput } from './worker-start-schema'
import type { WorkerWorktreeCreationTarget } from './worker-worktree-creation'
import { retriedWorkerDefaultAgent } from './retried-worker-default-agent'

export async function prepareLocalWorkerAgentParams(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  params: WorkerStartInput
  callerSession?: OrchestrationSessionCaller
  requestedWorktree: string
  createsWorktree: boolean
  creationTargetFor: (callerWorktreeId: string) => Promise<WorkerWorktreeCreationTarget>
}) {
  const { runtime, params, callerSession, requestedWorktree, createsWorktree } = args
  const resolveTarget = async () => {
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
  }
  const retried = retriedWorkerDefaultAgent(args.db, params)
  const defaultAgent = retried
    ? { params: { ...params, agent: retried.agent }, selection: retried.selection }
    : await resolveWorkerDefaultAgentParams(runtime, params, resolveTarget)
  const launchParams = await resolveWorkerConfiguredAgentParams(
    runtime,
    defaultAgent.params,
    resolveTarget
  )
  const openCodeModelLaunchSupported =
    !createsWorktree && launchParams.agent === 'opencode' && launchParams.model
      ? await probeWorkerOpenCodeModelLaunchSupport(runtime, launchParams, {
          worktree: (await resolveTarget()).worktree
        })
      : false
  return { launchParams, defaultSelection: defaultAgent.selection, openCodeModelLaunchSupported }
}
