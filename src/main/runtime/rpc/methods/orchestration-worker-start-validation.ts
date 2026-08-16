import { isTuiAgent } from '../../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { DispatchBudgetInput, OrchestrationDb } from '../../orchestration/db'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { FederationAttachStartInput } from './orchestration-federation-start-schema'
import {
  assertWorkerLaunchPreferencesCreateTerminal,
  createWorkerLaunchReceipt,
  resolveWorkerLaunchPreferences
} from './orchestration-worker-launch-preferences'
import type { WorkerStartInput } from './orchestration-worker-start-schema'

type WorkerStartLaunch = ReturnType<typeof resolveWorkerLaunchPreferences>
type BoundedWorkerControlInput = Pick<
  WorkerStartInput,
  | 'dispatchGroup'
  | 'dispatchIndex'
  | 'maxDispatches'
  | 'maxRuntimeMs'
  | 'maxRequests'
  | 'maxReviewCycles'
  | 'reviewCycle'
>

export type BoundedWorkerControls = {
  budget: DispatchBudgetInput
  leafControl: {
    leaf: true
    provider: TuiAgent
    enforcement: 'environment' | 'environment_and_cli' | 'adapter'
  }
}

export function resolveWorkerDeadlineAt(args: {
  db: Pick<OrchestrationDb, 'getWorkerDispatch'>
  retryOf?: string
  maxRuntimeMs: number
  now?: () => number
}): string {
  if (args.retryOf) {
    const prior = args.db.getWorkerDispatch(args.retryOf)
    if (prior) {
      return prior.deadline_at
    }
  }
  return new Date((args.now ?? Date.now)() + args.maxRuntimeMs).toISOString()
}

export function resolveBoundedWorkerControls(
  params: BoundedWorkerControlInput,
  agent: TuiAgent
): BoundedWorkerControls {
  if (agent !== 'claude' && agent !== 'codex') {
    throw new OrchestrationError(
      'leaf_control_unsupported',
      `Agent ${agent} does not expose a hard fan-out disable for bounded leaf workers.`
    )
  }
  const requestCapEnforcement: DispatchBudgetInput['requestCapEnforcement'] = 'prompt_only'
  const enforcement: BoundedWorkerControls['leafControl']['enforcement'] = 'environment_and_cli'
  return {
    budget: {
      group: params.dispatchGroup,
      index: params.dispatchIndex,
      maxDispatches: params.maxDispatches,
      maxRuntimeMs: params.maxRuntimeMs,
      maxRequests: params.maxRequests,
      requestCapEnforcement,
      maxReviewCycles: params.maxReviewCycles,
      ...(params.reviewCycle === undefined ? {} : { reviewCycle: params.reviewCycle }),
      leaf: true
    },
    leafControl: { leaf: true, provider: agent, enforcement }
  }
}

function rejectSupervisedTerminalReuse(params: { terminal?: string }): void {
  if (params.terminal) {
    throw new OrchestrationError(
      'bounded_worker_requires_fresh_process',
      'Supervised worker-start always creates a fresh bounded process; --terminal is unsupported.'
    )
  }
}

export function validateFederatedWorkerStartPlacement(
  params: WorkerStartInput,
  createsWorktree: boolean
): void {
  rejectSupervisedTerminalReuse(params)
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
  if (!params.terminal && (!params.agent || !isTuiAgent(params.agent))) {
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
}): { agent: TuiAgent | undefined; launch: WorkerStartLaunch } {
  const { params, createsWorktree, runtime } = args
  rejectSupervisedTerminalReuse(params)
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
    missingAgentMessage: 'A configured --agent is required when worker-start creates a terminal.'
  })
}

export function prepareFederationAttachmentWorkerStart(args: {
  params: FederationAttachStartInput
  createsWorktree: boolean
  runtime: OrcaRuntimeService
}): { agent: TuiAgent | undefined; launch: WorkerStartLaunch } {
  const { params, createsWorktree, runtime } = args
  rejectSupervisedTerminalReuse(params)
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
      'A configured --agent is required when federated worker-start creates a terminal.'
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
  if (!args.terminal && (!args.agent || !isTuiAgent(args.agent))) {
    throw new OrchestrationError('agent_unconfigured', args.missingAgentMessage)
  }
  const agent = args.agent as TuiAgent | undefined
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
