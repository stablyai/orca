import { isTuiAgent } from '../../../../../../../../shared/agent-launch/catalog/tui-agent-config'
import {
  isTuiAgentEnabled,
  TUI_AGENT_AUTO_PICK_ORDER
} from '../../../../../../../../shared/agent-launch/catalog/tui-agent-selection'
import type { TuiAgent } from '../../../../../../../../shared/agent-launch/catalog/tui-agent'
import type { OrcaRuntimeService } from '../../../../../../orca-runtime'
import { OrchestrationError } from '../../../../../../orchestration/orchestration-error'
import type { FederationAttachStartInput } from '../../../../../../../../shared/rpc-contract/orchestration/orchestration-federation-start-params'
import {
  assertWorkerLaunchPreferencesCreateTerminal,
  createWorkerLaunchReceipt,
  formatDroppedRetryLaunchWarning,
  resolveWorkerLaunchPreferences
} from './worker-launch-preferences'
import { probeWorkerOpenCodeModelLaunchSupport } from './worker-opencode-model-preflight'
import {
  refuseUnmatchedWorkerSelector,
  type WorkerStartSelectorLabel
} from '../worker-start-selector-refusal'
import type { WorkerStartInput } from '../worker-start-input'

type WorkerStartLaunch = ReturnType<typeof resolveWorkerLaunchPreferences>

const TERMINAL_WITH_AGENT_REFUSAL =
  '--terminal continues the agent already running there, in its current conversation. To start fresh, use --worktree or --agent without --terminal.'

export function validateFederatedWorkerStartPlacement(
  params: WorkerStartInput,
  createsWorktree: boolean
): void {
  if (createsWorktree && !params.repo) {
    throw new OrchestrationError(
      'invalid_argument',
      'Remote new-child and new-top-level require an explicit --repo from remote discovery.'
    )
  }
  if (createsWorktree && params.terminal) {
    throw new OrchestrationError(
      'invalid_argument',
      '--terminal cannot combine with remote new-worktree creation.'
    )
  }
  if (!createsWorktree && (params.name || params.repo || params.baseBranch || params.setup)) {
    throw new OrchestrationError(
      'invalid_argument',
      'Creation and setup options apply only to remote new-child or new-top-level worktrees.'
    )
  }
  if (params.terminal && params.agent) {
    throw new OrchestrationError('invalid_argument', TERMINAL_WITH_AGENT_REFUSAL)
  }
  if (!params.terminal && !params.agent) {
    throw new OrchestrationError(
      'agent_unconfigured',
      'A configured --agent is required when remote worker-start creates a terminal.'
    )
  }
}

export function prepareLocalWorkerStart(args: {
  params: WorkerStartInput
  createsWorktree: boolean
  runtime: OrcaRuntimeService
  openCodeModelLaunchSupported?: boolean
}): { agent: TuiAgent | undefined; launch: WorkerStartLaunch } {
  const { params, createsWorktree, runtime } = args
  assertWorkerLaunchPreferencesCreateTerminal(params)
  if (params.terminal && params.agent) {
    throw new OrchestrationError('invalid_argument', TERMINAL_WITH_AGENT_REFUSAL)
  }
  if (createsWorktree && params.terminal) {
    throw new OrchestrationError(
      'invalid_argument',
      '--terminal cannot combine with new-worktree creation.'
    )
  }
  if (!createsWorktree && (params.name || params.repo || params.baseBranch || params.setup)) {
    throw new OrchestrationError(
      'invalid_argument',
      'Creation and setup options apply only to new-child or new-top-level worktrees.'
    )
  }
  return resolveWorkerStartAgent({
    runtime,
    openCodeModelLaunchSupported: args.openCodeModelLaunchSupported,
    createsWorktree,
    terminal: params.terminal,
    agent: params.agent,
    model: params.model,
    effort: params.effort,
    inheritedLaunchPreferences: params.inheritedLaunchPreferences,
    missingAgentMessage: 'A configured --agent is required when worker-start creates a terminal.'
  })
}

export async function resolveLocalWorkerStartLaunch(args: {
  params: WorkerStartInput
  createsWorktree: boolean
  existingWorktree: string
  targetLabel: WorkerStartSelectorLabel
  runtime: OrcaRuntimeService
}): Promise<{
  agent: TuiAgent | undefined
  launch: WorkerStartLaunch
  warning?: string
}> {
  const { params, createsWorktree, existingWorktree, targetLabel, runtime } = args
  let openCodeModelLaunchSupported = false
  let probeDropWarning: string | undefined
  if (!createsWorktree && params.agent === 'opencode' && params.model) {
    try {
      openCodeModelLaunchSupported = await refuseUnmatchedWorkerSelector(targetLabel, () =>
        probeWorkerOpenCodeModelLaunchSupport(runtime, params, { worktree: existingWorktree })
      )
    } catch (error) {
      if (
        params.inheritedLaunchPreferences &&
        error instanceof OrchestrationError &&
        error.code === 'capability_unsupported'
      ) {
        probeDropWarning = formatDroppedRetryLaunchWarning(params, error.message)
      } else {
        throw error
      }
    }
  }
  const prepared = prepareLocalWorkerStart({
    params: probeDropWarning
      ? { ...params, model: undefined, effort: undefined, inheritedLaunchPreferences: false }
      : params,
    createsWorktree,
    runtime,
    openCodeModelLaunchSupported
  })
  const warning = probeDropWarning ?? prepared.launch.warning
  return { ...prepared, ...(warning ? { warning } : {}) }
}

export function prepareFederationAttachmentWorkerStart(args: {
  params: FederationAttachStartInput
  createsWorktree: boolean
  runtime: OrcaRuntimeService
  openCodeModelLaunchSupported?: boolean
}): { agent: TuiAgent | undefined; launch: WorkerStartLaunch } {
  const { params, createsWorktree, runtime } = args
  assertWorkerLaunchPreferencesCreateTerminal(params)
  if (createsWorktree && !params.repo) {
    throw new OrchestrationError(
      'invalid_argument',
      'A remote new-top-level worktree requires an explicit --repo.'
    )
  }
  if (createsWorktree && params.terminal) {
    throw new OrchestrationError(
      'invalid_argument',
      '--terminal cannot combine with remote new-worktree creation.'
    )
  }
  if (
    !createsWorktree &&
    (params.name || params.repo || params.baseBranch || params.setup || params.setupSource)
  ) {
    throw new OrchestrationError(
      'invalid_argument',
      'Creation and setup options apply only to remote new-top-level worktrees.'
    )
  }
  if (params.terminal && params.agent) {
    throw new OrchestrationError('invalid_argument', TERMINAL_WITH_AGENT_REFUSAL)
  }
  return resolveWorkerStartAgent({
    runtime,
    openCodeModelLaunchSupported: args.openCodeModelLaunchSupported,
    createsWorktree,
    terminal: params.terminal,
    agent: params.agent,
    model: params.model,
    effort: params.effort,
    missingAgentMessage:
      'A configured --agent is required when federated worker-start creates a terminal.'
  })
}

function resolveWorkerStartAgent(args: {
  runtime: OrcaRuntimeService
  openCodeModelLaunchSupported?: boolean
  createsWorktree: boolean
  terminal?: string
  agent?: string
  model?: string
  effort?: string
  inheritedLaunchPreferences?: boolean
  missingAgentMessage: string
}): { agent: TuiAgent | undefined; launch: WorkerStartLaunch } {
  const agent = args.agent
    ? isTuiAgent(args.agent)
      ? args.agent
      : args.runtime.resolveOrchestrationAgentLauncher?.(args.agent)
    : undefined
  if (!args.terminal && !agent) {
    const { disabledTuiAgents } = args.runtime.getClientSettings()
    const agents = TUI_AGENT_AUTO_PICK_ORDER.filter((id) =>
      isTuiAgentEnabled(id, disabledTuiAgents)
    )
    throw new OrchestrationError(
      'agent_unconfigured',
      agents.length
        ? `${args.missingAgentMessage} Pass --agent with one of: ${agents.join(', ')}.`
        : args.missingAgentMessage
    )
  }
  if (agent) {
    args.runtime.validateOrchestrationAgentLauncher(agent)
    return {
      agent,
      launch: resolveWorkerLaunchPreferences({
        agent,
        openCodeModelLaunchSupported: args.openCodeModelLaunchSupported,
        createsWorktree: args.createsWorktree,
        model: args.model,
        effort: args.effort,
        inheritedLaunchPreferences: args.inheritedLaunchPreferences
      })
    }
  }
  return {
    agent: undefined,
    launch: {
      preferences: undefined,
      receipt: createWorkerLaunchReceipt({ agent: null })
    }
  }
}
