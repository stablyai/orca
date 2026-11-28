import {
  prepareFederationConfiguredWorkerStart,
  resolveWorkerConfiguredAgentParams
} from './worker-configured-agent-preflight'
import { formatDroppedRetryLaunchWarning } from './worker-launch-preferences'
import {
  prepareLocalWorkerStart,
  type prepareFederationAttachmentWorkerStart
} from './worker-start-validation'
import {
  refuseUnmatchedWorkerSelector,
  type WorkerStartSelectorLabel
} from '../worker-start-selector-refusal'
import type { WorkerStartInput } from '../worker-start-input'
import {
  agentCopyBase,
  selectsAgent
} from '../../../../../../../../shared/agent-launch/catalog/agent-copies'
import type { OrcaRuntimeService } from '../../../../../../orca-runtime'
import { OrchestrationError } from '../../../../../../orchestration/orchestration-error'

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

export async function resolveLocalWorkerStartLaunch(args: {
  params: WorkerStartInput
  createsWorktree: boolean
  existingWorktree: string
  targetLabel: WorkerStartSelectorLabel
  runtime: OrcaRuntimeService
  resolveTarget: () => Promise<{ repo?: string; worktree?: string }>
}) {
  const { createsWorktree, existingWorktree, targetLabel, runtime, resolveTarget } = args
  const launchParams = await refuseUnmatchedWorkerSelector(targetLabel, () =>
    resolveWorkerConfiguredAgentParams(runtime, args.params, resolveTarget)
  )
  let openCodeModelLaunchSupported = false
  let probeDropWarning: string | undefined
  if (!createsWorktree && selectsAgent(launchParams.agent, 'opencode') && launchParams.model) {
    try {
      openCodeModelLaunchSupported = await refuseUnmatchedWorkerSelector(targetLabel, () =>
        probeWorkerOpenCodeModelLaunchSupport(runtime, launchParams, { worktree: existingWorktree })
      )
    } catch (error) {
      if (
        launchParams.inheritedLaunchPreferences &&
        error instanceof OrchestrationError &&
        error.code === 'capability_unsupported'
      ) {
        probeDropWarning = formatDroppedRetryLaunchWarning(launchParams, error.message)
      } else {
        throw error
      }
    }
  }
  const prepared = prepareLocalWorkerStart({
    params: probeDropWarning
      ? { ...launchParams, model: undefined, effort: undefined, inheritedLaunchPreferences: false }
      : launchParams,
    createsWorktree,
    runtime,
    openCodeModelLaunchSupported
  })
  const warning = probeDropWarning ?? prepared.launch.warning
  return { ...prepared, ...(warning ? { warning } : {}) }
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
