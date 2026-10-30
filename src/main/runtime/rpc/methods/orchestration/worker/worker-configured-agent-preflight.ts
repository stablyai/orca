import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { isTuiAgent } from '../../../../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../../../../shared/tui-agent'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { prepareFederationAttachmentWorkerStart } from './worker-start-validation'
import { resolveProjectDefaultAgent } from '../../../../project-default-agent-resolution'

type WorkerAgentTarget = { repo?: string; worktree?: string }

export type WorkerDefaultAgentSelection = {
  agent: TuiAgent
  source: 'project' | 'global' | 'automatic' | 'explicit'
  projectId?: string
  projectName?: string
}

export async function resolveWorkerDefaultAgentParams<T extends { agent?: string }>(
  runtime: OrcaRuntimeService,
  params: T,
  resolveTarget: () => Promise<WorkerAgentTarget>
): Promise<{ params: T; selection?: WorkerDefaultAgentSelection }> {
  if (params.agent !== 'default') {
    return { params }
  }
  const target = await resolveTarget()
  const resolved = await resolveProjectDefaultAgent(
    runtime,
    target.repo
      ? { repo: await runtime.showRepo(target.repo) }
      : { worktreeId: (await runtime.showManagedTerminalWorkspace(target.worktree!)).id }
  )
  if (!resolved.agent) {
    throw new OrchestrationError(
      'agent_unconfigured',
      `The default agent for ${resolved.projectName ?? target.repo ?? target.worktree ?? 'this workspace'} is Blank Terminal or unavailable. Choose an explicit --agent or update the project default. No effects were applied.`
    )
  }
  return {
    params: { ...params, agent: resolved.agent },
    selection: {
      agent: resolved.agent,
      source: resolved.source,
      ...(resolved.projectId ? { projectId: resolved.projectId } : {}),
      ...(resolved.projectName ? { projectName: resolved.projectName } : {})
    }
  }
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
