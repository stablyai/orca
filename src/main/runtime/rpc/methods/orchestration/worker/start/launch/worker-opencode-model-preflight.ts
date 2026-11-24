import { refuseUnmatchedWorkerSelector } from '../worker-start-selector-refusal'
import {
  prepareFederationConfiguredWorkerStart,
  resolveWorkerConfiguredAgentParams
} from './worker-configured-agent-preflight'
import {
  prepareLocalWorkerStart,
  type prepareFederationAttachmentWorkerStart
} from './worker-start-validation'
import type { WorkerStartInput } from '../worker-start-input'
import type { OrcaRuntimeService } from '../../../../../../orca-runtime'

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
  return prepareFederationConfiguredWorkerStart({ ...args, params, openCodeModelLaunchSupported })
}

export async function prepareLocalWorkerStartWithPreflight(args: {
  runtime: OrcaRuntimeService
  launchParams: WorkerStartInput
  createsWorktree: boolean
  existingWorktree: string | undefined
  targetLabel: Parameters<typeof refuseUnmatchedWorkerSelector>[0]
}) {
  const { runtime, launchParams, createsWorktree, existingWorktree, targetLabel } = args
  let openCodeModelLaunchSupported = false
  if (!createsWorktree && launchParams.agent === 'opencode' && launchParams.model) {
    openCodeModelLaunchSupported = await refuseUnmatchedWorkerSelector(targetLabel, () =>
      probeWorkerOpenCodeModelLaunchSupport(runtime, launchParams, { worktree: existingWorktree })
    )
  }
  return prepareLocalWorkerStart({
    params: launchParams,
    createsWorktree,
    runtime,
    openCodeModelLaunchSupported
  })
}
