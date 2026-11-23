import type { OrcaRuntimeService } from '../../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../../orchestration/db/orchestration-db'
import {
  resolveWorkerConfiguredAgentParams,
  resolveWorkerDefaultAgentParams
} from './launch/worker-configured-agent-preflight'
import { probeWorkerOpenCodeModelLaunchSupport } from './launch/worker-opencode-model-preflight'
import type { WorkerStartInput } from './worker-start-input'
import type { WorkerWorktreeCreationTarget } from './placement/worker-worktree-creation'
import { retriedWorkerDefaultAgent } from './launch/retried-worker-default-agent'

export async function prepareLocalWorkerAgentParams(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  params: WorkerStartInput
  callerWorktreeId: string
  requestedWorktree: string
  createsWorktree: boolean
  creationTargetFor: (callerWorktreeId: string) => Promise<WorkerWorktreeCreationTarget>
}) {
  const { runtime, params, callerWorktreeId, requestedWorktree, createsWorktree } = args
  const resolveTarget = async () => {
    return createsWorktree
      ? { repo: (await args.creationTargetFor(callerWorktreeId)).repoSelector }
      : {
          worktree: requestedWorktree === 'current' ? `id:${callerWorktreeId}` : requestedWorktree
        }
  }
  const retried = retriedWorkerDefaultAgent(args.db, params)
  const defaultAgent = await resolveWorkerDefaultAgentParams(
    runtime,
    retried
      ? { ...params, agent: retried.agent, resolvedAgentSelection: retried.selection }
      : params,
    resolveTarget
  )
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
