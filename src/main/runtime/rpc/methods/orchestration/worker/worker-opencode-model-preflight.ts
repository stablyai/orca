import { readWorkerCodexDiscoveredEfforts } from './worker-codex-effort-preflight'
import {
  prepareFederationConfiguredWorkerStart,
  resolveWorkerConfiguredAgentParams
} from './worker-configured-agent-preflight'
import type { prepareFederationAttachmentWorkerStart } from './worker-start-validation'
import type { OrcaRuntimeService } from '../../../../orca-runtime'

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
    'openCodeModelLaunchSupported' | 'discoveredEfforts'
  >
) {
  const resolveTarget = async () =>
    args.createsWorktree ? { repo: args.params.repo } : { worktree: args.params.worktree }
  const params = await resolveWorkerConfiguredAgentParams(args.runtime, args.params, resolveTarget)
  const openCodeModelLaunchSupported =
    !args.createsWorktree &&
    (await probeWorkerOpenCodeModelLaunchSupport(args.runtime, params, {
      worktree: params.worktree
    }))
  const discoveredEfforts = await readWorkerCodexDiscoveredEfforts(
    args.runtime,
    params,
    resolveTarget
  )
  return prepareFederationConfiguredWorkerStart({
    ...args,
    params,
    openCodeModelLaunchSupported,
    discoveredEfforts
  })
}
