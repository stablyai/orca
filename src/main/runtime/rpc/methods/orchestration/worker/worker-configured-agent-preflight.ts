import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { isTuiAgent } from '../../../../../../shared/tui-agent-config'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { prepareFederationAttachmentWorkerStart } from './worker-start-validation'
import type { OrchestrationSessionCaller } from '../../../../orchestration/orchestration-caller-identity'
import { resolveDispatchCallerWorktreeId } from '../../orchestration-caller-workspace'
import type { WorkerStartInput } from './worker-start-schema'

type WorkerAgentTarget = { repo?: string; worktree?: string }

export async function resolveLocalWorkerLaunchTarget(
  runtime: OrcaRuntimeService,
  params: WorkerStartInput,
  callerSession?: OrchestrationSessionCaller
): Promise<WorkerAgentTarget> {
  const requestedWorktree = params.worktree ?? 'current'
  const createsWorktree = requestedWorktree === 'new-child' || requestedWorktree === 'new-top-level'
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
    : { worktree: requestedWorktree === 'current' ? `id:${callerWorkspaceId}` : requestedWorktree }
}

export async function resolveWorkerConfiguredAgentParams<T extends { agent?: string }>(
  runtime: OrcaRuntimeService,
  params: T,
  resolveTarget: () => Promise<WorkerAgentTarget>
): Promise<T> {
  if (!params.agent || isTuiAgent(params.agent)) {
    return params
  }
  const agent = await runtime.resolveOrchestrationAgentLauncherForTarget(
    params.agent,
    await resolveTarget()
  )
  if (!agent) {
    throw new OrchestrationError(
      'agent_unconfigured',
      'A configured single-executable agent alias is required.'
    )
  }
  return { ...params, agent }
}

export async function prepareFederationConfiguredWorkerStart(
  args: Parameters<typeof prepareFederationAttachmentWorkerStart>[0]
) {
  const params = await resolveWorkerConfiguredAgentParams(args.runtime, args.params, async () =>
    args.createsWorktree ? { repo: args.params.repo } : { worktree: args.params.worktree }
  )
  return prepareFederationAttachmentWorkerStart({ ...args, params })
}
