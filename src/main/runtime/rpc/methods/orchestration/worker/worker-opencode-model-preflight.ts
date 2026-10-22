import {
  prepareFederationConfiguredWorkerStart,
  resolveWorkerConfiguredAgentParams
} from './worker-configured-agent-preflight'
import type { prepareFederationAttachmentWorkerStart } from './worker-start-validation'
import type { OrcaRuntimeService } from '../../../../orca-runtime'

export async function assertWorkerDshModelLaunchSupport(
  runtime: OrcaRuntimeService,
  params: { agent?: string; model?: string; effort?: string },
  target: { worktree?: string; repo?: string }
): Promise<void> {
  if (params.agent === 'dsh' && params.model) {
    await runtime.assertOrchestrationDshModelLaunchSupport({
      ...target,
      model: params.model,
      ...(params.effort ? { effort: params.effort } : {})
    })
  }
}

export async function probeWorkerOpenCodeModelLaunchSupport(
  runtime: OrcaRuntimeService,
  params: { agent?: string; model?: string },
  target: { worktree?: string }
): Promise<boolean> {
  return Boolean(
    params.model &&
    params.agent &&
    runtime.resolveOrchestrationAgentLauncher(params.agent) === 'opencode' &&
    (await runtime.probeOrchestrationOpenCodeModelLaunchSupport({ ...target, model: params.model }))
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
  await assertWorkerDshModelLaunchSupport(
    args.runtime,
    params,
    args.createsWorktree ? { repo: params.repo } : { worktree: params.worktree }
  )
  return prepareFederationConfiguredWorkerStart({ ...args, params, openCodeModelLaunchSupported })
}
