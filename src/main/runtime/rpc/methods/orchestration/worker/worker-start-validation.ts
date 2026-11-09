import { isTuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent-config'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'
import { resolveEnabledDefaultTuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent-selection'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { FederationAttachStartInput } from '../../../../../../shared/rpc-contract/orchestration-federation-start-params'
import {
  assertWorkerLaunchPreferencesCreateTerminal,
  createWorkerLaunchReceipt,
  resolveWorkerLaunchPreferences
} from './worker-launch-preferences'
import type { WorkerStartInput } from './worker-start-schema'

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
  // Why: an omitted --agent uses the worker host's Settings default, and only that host can
  // resolve a configured command alias, so the name is validated there.
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
    missingAgentMessage:
      'An enabled --agent (or an enabled default agent in Settings) is required when worker-start creates a terminal.'
  })
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
      'An enabled --agent (or an enabled default agent in Settings) is required when federated worker-start creates a terminal.'
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
  missingAgentMessage: string
}): { agent: TuiAgent | undefined; launch: WorkerStartLaunch } {
  const agent = args.terminal
    ? undefined
    : args.agent === undefined
      ? resolveDefaultWorkerAgent(args.runtime)
      : resolveNamedWorkerAgent(args.runtime, args.agent)
  // Why: only an omitted --agent falls back to the Settings default; a mistyped, empty, or
  // unconfigured name must fail rather than silently launch a different agent.
  if (!args.terminal && args.agent !== undefined && !agent) {
    throw new OrchestrationError(
      'agent_unconfigured',
      `--agent "${args.agent}" is not an agent id or a configured command alias.`
    )
  }
  if (!args.terminal && !agent) {
    throw new OrchestrationError('agent_unconfigured', args.missingAgentMessage)
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
        effort: args.effort
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

function resolveNamedWorkerAgent(runtime: OrcaRuntimeService, name: string): TuiAgent | undefined {
  if (isTuiAgent(name)) {
    return name
  }
  return name ? runtime.resolveOrchestrationAgentLauncher?.(name) : undefined
}

// Matches the new-workspace picker: a disabled default is never swapped for another agent.
function resolveDefaultWorkerAgent(runtime: OrcaRuntimeService): TuiAgent | undefined {
  return resolveEnabledDefaultTuiAgent(runtime.getClientAgentLaunchSettings()) ?? undefined
}
