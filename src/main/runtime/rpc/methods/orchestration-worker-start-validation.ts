import { isTuiAgent } from '../../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { FederationAttachStartInput } from './orchestration-federation-start-schema'
import {
  assertWorkerLaunchPreferencesCreateTerminal,
  createWorkerLaunchReceipt,
  resolveWorkerLaunchPreferences
} from './orchestration-worker-launch-preferences'
import type { WorkerStartInput } from './orchestration-worker-start-schema'

type WorkerStartLaunch = ReturnType<typeof resolveWorkerLaunchPreferences>

export function validateFederatedWorkerStartPlacement(
  params: WorkerStartInput,
  createsWorktree: boolean
): void {
  if (createsWorktree && (!params.name || !params.repo)) {
    throw new OrchestrationError(
      'invalid_argument',
      'Remote new-top-level requires --name and an explicit --repo from remote discovery.'
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
      'Creation and setup options apply only to remote new-top-level worktrees.'
    )
  }
  if (params.terminal && params.agent) {
    throw new OrchestrationError(
      'invalid_argument',
      '--terminal reuses an existing agent and cannot combine with --agent.'
    )
  }
  // Why: an explicit --agent must be a known id; an omitted one is resolved by the
  // worker host against its own Settings default.
  if (!params.terminal && params.agent && !isTuiAgent(params.agent)) {
    throw new OrchestrationError(
      'agent_unconfigured',
      'An enabled --agent (or an enabled default agent in Settings) is required when remote worker-start creates a terminal.'
    )
  }
}

export function prepareLocalWorkerStart(args: {
  params: WorkerStartInput
  createsWorktree: boolean
  runtime: OrcaRuntimeService
}): { agent: TuiAgent | undefined; launch: WorkerStartLaunch } {
  const { params, createsWorktree, runtime } = args
  assertWorkerLaunchPreferencesCreateTerminal(params)
  if (params.terminal && params.agent) {
    throw new OrchestrationError(
      'invalid_argument',
      '--terminal reuses an existing agent and cannot combine with --agent.'
    )
  }
  if (createsWorktree && params.terminal) {
    throw new OrchestrationError(
      'invalid_argument',
      '--terminal cannot combine with new-worktree creation.'
    )
  }
  if (createsWorktree && !params.name) {
    throw new OrchestrationError('invalid_argument', 'New worktrees require --name.')
  }
  if (!createsWorktree && (params.name || params.repo || params.baseBranch || params.setup)) {
    throw new OrchestrationError(
      'invalid_argument',
      'Creation and setup options apply only to new-child or new-top-level worktrees.'
    )
  }
  return resolveWorkerStartAgent({
    runtime,
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
}): { agent: TuiAgent | undefined; launch: WorkerStartLaunch } {
  const { params, createsWorktree, runtime } = args
  assertWorkerLaunchPreferencesCreateTerminal(params)
  if (createsWorktree && (!params.name || !params.repo)) {
    throw new OrchestrationError(
      'invalid_argument',
      'A remote new-top-level worktree requires --name and an explicit --repo.'
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
    throw new OrchestrationError(
      'invalid_argument',
      '--terminal reuses an existing agent and cannot combine with --agent.'
    )
  }
  return resolveWorkerStartAgent({
    runtime,
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
  terminal?: string
  agent?: string
  model?: string
  effort?: string
  missingAgentMessage: string
}): { agent: TuiAgent | undefined; launch: WorkerStartLaunch } {
  const agent = args.terminal
    ? undefined
    : (parseTuiAgent(args.agent) ?? resolveDefaultWorkerAgent(args.runtime))
  if (!args.terminal && !agent) {
    throw new OrchestrationError('agent_unconfigured', args.missingAgentMessage)
  }
  if (agent) {
    args.runtime.validateOrchestrationAgentLauncher(agent)
    return {
      agent,
      launch: resolveWorkerLaunchPreferences({
        agent,
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

function parseTuiAgent(value: string | undefined): TuiAgent | undefined {
  return value && isTuiAgent(value) ? value : undefined
}

function resolveDefaultWorkerAgent(runtime: OrcaRuntimeService): TuiAgent | undefined {
  return runtime.resolveDefaultOrchestrationAgent() ?? undefined
}
