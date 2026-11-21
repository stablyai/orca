import {
  prepareFederationConfiguredWorkerStart,
  resolveWorkerConfiguredAgentParams
} from './worker-configured-agent-preflight'
import type { prepareFederationAttachmentWorkerStart } from './worker-start-validation'
import { agentCopyBase } from '../../../../../../../../shared/agent-launch/catalog/agent-copies'
import type { OrcaRuntimeService } from '../../../../../../orca-runtime'

export async function probeWorkerOpenCodeModelLaunchSupport(
  runtime: Pick<
    OrcaRuntimeService,
    'resolveOrchestrationAgentLauncher' | 'probeOrchestrationOpenCodeModelLaunchSupport'
  >,
  params: { agent?: string; model?: string },
  target: { worktree?: string }
): Promise<boolean> {
  // An OpenCode copy is probed on the route it launches with: its own command and env.
  const copyBase = params.agent ? agentCopyBase(params.agent) : null
  const agent = copyBase ?? params.agent
  return Boolean(
    params.model &&
    agent &&
    runtime.resolveOrchestrationAgentLauncher(agent) === 'opencode' &&
    (await runtime.probeOrchestrationOpenCodeModelLaunchSupport({
      ...target,
      model: params.model,
      ...(copyBase ? { agentCopy: params.agent } : {})
    }))
  )
}

export async function prepareFederationWorkerLaunchOnHost(
  args: Omit<
    Parameters<typeof prepareFederationAttachmentWorkerStart>[0],
    'openCodeModelLaunchSupported'
  >
) {
  const params = await resolveWorkerConfiguredAgentParams(args.runtime, args.params, async () =>
    args.createsWorktree ? { repo: args.params.repo } : { worktree: args.params.worktree }
  )
  const openCodeModelLaunchSupported =
    !args.createsWorktree &&
    (await probeWorkerOpenCodeModelLaunchSupport(args.runtime, params, {
      worktree: params.worktree
    }))
  return prepareFederationConfiguredWorkerStart({ ...args, params, openCodeModelLaunchSupported })
}
