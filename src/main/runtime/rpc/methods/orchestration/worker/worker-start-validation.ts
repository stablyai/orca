import { isTuiAgent } from '../../../../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../../../../shared/tui-agent'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import {
  discoveredModelsReplaceSeed,
  getAgentSessionOptionCatalog
} from '../../../../../../shared/agent-session-option-catalog'
import { hasExplicitTuiLaunchCustomization } from '../../../../../../shared/tui-agent-launch-customization'
import type { FederationAttachStartInput } from '../federation/federation-start-schema'
import { resolveDispatchCallerWorktreeId } from '../../orchestration-caller-workspace'
import {
  resolveWorkerLaunchModelAuthority,
  type WorkerLaunchModelDiscoveryTarget
} from './worker-launch-model-authority'
import {
  assertWorkerLaunchPreferencesCreateTerminal,
  createWorkerLaunchReceipt,
  resolveWorkerLaunchPreferences
} from './worker-launch-preferences'
import type { WorkerStartInput } from './worker-start-schema'

type WorkerStartLaunch = ReturnType<typeof resolveWorkerLaunchPreferences>
type WorkerStartAgentPlan = {
  agent: TuiAgent | undefined
  launch: WorkerStartLaunch
  /** Present only when the model probe already paid for it; `startLocalWorker` reuses it
   *  instead of making a second `showTerminal` round trip for the same dispatch. */
  callerWorktreeId?: string
}

const COORDINATOR_HOSTED_PLACEMENTS = new Set(['current', 'new-child', 'new-top-level'])

function modelProbeMissesLaunchCustomization(
  settings: ReturnType<OrcaRuntimeService['getClientSettings']>,
  agent: TuiAgent
): boolean {
  const { agentDefaultArgs, agentDefaultEnv } = settings
  // Command overrides are part of model discovery. Terminal-only args and env are not, so their
  // catalog cannot safely reject a value the actual launch may accept.
  return hasExplicitTuiLaunchCustomization({ agentDefaultArgs, agentDefaultEnv }, agent)
}

function readWorkerLaunchSettings(
  runtime: OrcaRuntimeService
): ReturnType<OrcaRuntimeService['getClientSettings']> | null {
  try {
    return runtime.getClientSettings()
  } catch {
    // Missing settings cannot prove that discovery matches the eventual launch command.
    return null
  }
}

function canResolveWorkerLaunchModelAuthority(
  agent: string | undefined,
  model: string | undefined
): boolean {
  if (!model || !agent || !isTuiAgent(agent)) {
    return false
  }
  const catalog = getAgentSessionOptionCatalog(agent)
  return Boolean(
    catalog?.supportsWorkerLaunchPreferences &&
    catalog.modelApply.launchArgs &&
    discoveredModelsReplaceSeed(agent, catalog)
  )
}

/**
 * The worktree whose host will run the worker, as a selector the model probe can resolve.
 * A worktree that does not exist yet inherits the coordinator's host, which is where it is made.
 */
async function resolveLocalLaunchHost(
  runtime: OrcaRuntimeService,
  params: WorkerStartInput
): Promise<{ selector: WorkerLaunchModelDiscoveryTarget | null; callerWorktreeId?: string }> {
  const requested = params.worktree ?? 'current'
  if ((requested === 'new-child' || requested === 'new-top-level') && params.repo) {
    return { selector: { repoSelector: params.repo } }
  }
  if (!COORDINATOR_HOSTED_PLACEMENTS.has(requested)) {
    return { selector: requested }
  }
  try {
    const callerWorktreeId = await resolveDispatchCallerWorktreeId(runtime, params.from)
    return { selector: `id:${callerWorktreeId}`, callerWorktreeId }
  } catch {
    // The same failure resurfaces where the dispatch actually needs the coordinator's worktree.
    return { selector: null }
  }
}

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
  if (!params.terminal && (!params.agent || !isTuiAgent(params.agent))) {
    throw new OrchestrationError(
      'agent_unconfigured',
      'A configured --agent is required when remote worker-start creates a terminal.'
    )
  }
}

export async function prepareLocalWorkerStart(args: {
  params: WorkerStartInput
  createsWorktree: boolean
  runtime: OrcaRuntimeService
}): Promise<WorkerStartAgentPlan> {
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
  const host: {
    selector: WorkerLaunchModelDiscoveryTarget | null
    callerWorktreeId?: string
  } = canResolveWorkerLaunchModelAuthority(params.agent, params.model)
    ? await resolveLocalLaunchHost(runtime, params)
    : { selector: null }
  const plan = await resolveWorkerStartAgent({
    runtime,
    terminal: params.terminal,
    agent: params.agent,
    model: params.model,
    effort: params.effort,
    worktreeSelector: host.selector,
    missingAgentMessage: 'A configured --agent is required when worker-start creates a terminal.'
  })
  return host.callerWorktreeId ? { ...plan, callerWorktreeId: host.callerWorktreeId } : plan
}

export async function prepareFederationAttachmentWorkerStart(args: {
  params: FederationAttachStartInput
  createsWorktree: boolean
  runtime: OrcaRuntimeService
}): Promise<WorkerStartAgentPlan> {
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
    worktreeSelector: createsWorktree ? { repoSelector: params.repo as string } : params.worktree,
    missingAgentMessage:
      'A configured --agent is required when federated worker-start creates a terminal.'
  })
}

async function resolveWorkerStartAgent(args: {
  runtime: OrcaRuntimeService
  terminal?: string
  agent?: string
  model?: string
  effort?: string
  worktreeSelector: WorkerLaunchModelDiscoveryTarget | null
  missingAgentMessage: string
}): Promise<WorkerStartAgentPlan> {
  if (!args.terminal && (!args.agent || !isTuiAgent(args.agent))) {
    throw new OrchestrationError('agent_unconfigured', args.missingAgentMessage)
  }
  const agent = args.agent as TuiAgent | undefined
  if (agent) {
    args.runtime.validateOrchestrationAgentLauncher(agent)
    const catalog = args.model ? getAgentSessionOptionCatalog(agent) : null
    const launch = resolveWorkerLaunchPreferences({
      agent,
      model: args.model,
      effort: args.effort
    })
    if (!catalog || !discoveredModelsReplaceSeed(agent, catalog)) {
      return { agent, launch }
    }
    const settings = readWorkerLaunchSettings(args.runtime)
    if (!settings || modelProbeMissesLaunchCustomization(settings, agent)) {
      return { agent, launch }
    }
    return {
      agent,
      launch: resolveWorkerLaunchPreferences({
        agent,
        model: args.model,
        effort: args.effort,
        authority: await resolveWorkerLaunchModelAuthority({
          catalog,
          agent,
          agentCommandOverride: settings.agentCmdOverrides?.[agent],
          runtime: args.runtime,
          worktreeSelector: args.worktreeSelector
        })
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
