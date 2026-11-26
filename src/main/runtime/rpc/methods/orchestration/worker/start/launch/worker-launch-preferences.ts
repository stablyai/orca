import type { AgentLaunchPreferences } from '../../../../../../../../shared/agent-session/lifecycle/operations/agent-session-host-authority'
import { checkAgentLaunchModelPreferences } from '../../../../../../../../shared/agent-launch/choices/agent-launch-model-preferences'
import {
  resolveOrchestrationWorkerEffort,
  supportsLaunchModel,
  type OrchestrationWorkerLaunchDefaults
} from '../../../../../../../../shared/orchestration/workers/orchestration-worker-model-settings'
import { ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY } from '../../../../../../../../shared/orchestration/orchestration-runtime-capabilities'
import type { TuiAgent } from '../../../../../../../../shared/agent-launch/catalog/tui-agent'
import { isTuiAgent } from '../../../../../../../../shared/agent-launch/catalog/tui-agent-config'
import type { OrcaRuntimeService } from '../../../../../../orca-runtime'
import type { AgentMessageSender } from '../../../../../../../../shared/agent-session/journal/agent-session-message-source'
import { OrchestrationError } from '../../../../../../orchestration/orchestration-error'
import type { WorkerStartInput } from '../worker-start-input'

export type OrchestrationWorkerLaunchDefaultsApplied = {
  agent: boolean
  model: boolean
  effort: boolean
}

export function resolveOrchestrationWorkerLaunchDefaults(args: {
  terminal?: string
  agent?: string
  model?: string
  effort?: string
  defaults: OrchestrationWorkerLaunchDefaults
}): {
  agent?: string
  model?: string
  effort?: string
  applied: OrchestrationWorkerLaunchDefaultsApplied
} {
  if (args.terminal) {
    return {
      agent: args.agent,
      model: args.model,
      effort: args.effort,
      applied: { agent: false, model: false, effort: false }
    }
  }

  const agent = args.agent ?? args.defaults.agent ?? undefined
  const appliedAgent = args.agent === undefined && agent !== undefined
  const canResolveAgent = agent !== undefined && isTuiAgent(agent)
  const defaultModel =
    canResolveAgent && supportsLaunchModel(agent) ? args.defaults.models[agent]?.trim() : undefined
  const model = args.model ?? (defaultModel || undefined)
  const appliedModel = args.model === undefined && model !== undefined
  const defaultEffort = canResolveAgent
    ? resolveOrchestrationWorkerEffort(agent, model, args.defaults.efforts[agent])
    : undefined
  const effort = args.effort ?? defaultEffort
  const appliedEffort = args.effort === undefined && effort !== undefined

  return {
    agent,
    model,
    effort,
    applied: { agent: appliedAgent, model: appliedModel, effort: appliedEffort }
  }
}

export function resolveFederatedWorkerLaunchParams(args: {
  params: WorkerStartInput
  capabilities?: readonly string[]
  defaultsApplied?: OrchestrationWorkerLaunchDefaultsApplied
}): WorkerStartInput {
  const applied = args.defaultsApplied ?? { agent: false, model: false, effort: false }
  const hasExplicit =
    (args.params.model !== undefined && !applied.model) ||
    (args.params.effort !== undefined && !applied.effort)
  if (
    args.capabilities?.includes(ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY) ||
    hasExplicit
  ) {
    return args.params
  }
  const withoutPreferences = { ...args.params }
  delete withoutPreferences.model
  delete withoutPreferences.effort
  return withoutPreferences
}

/** Settings fill only what the caller and follow-up placement both left unnamed. */
export function applyWorkerStartSettingsDefaults<
  T extends { terminal?: string; agent?: string; model?: string; effort?: string }
>(
  runtime: Pick<OrcaRuntimeService, 'getOrchestrationWorkerLaunchDefaults'>,
  params: T
): { params: T; defaultsApplied: OrchestrationWorkerLaunchDefaultsApplied } {
  const resolved = resolveOrchestrationWorkerLaunchDefaults({
    terminal: params.terminal,
    agent: params.agent,
    model: params.model,
    effort: params.effort,
    defaults: runtime.getOrchestrationWorkerLaunchDefaults()
  })
  return {
    params: {
      ...params,
      ...(resolved.agent !== undefined ? { agent: resolved.agent } : {}),
      ...(resolved.model !== undefined ? { model: resolved.model } : {}),
      ...(resolved.effort !== undefined ? { effort: resolved.effort } : {})
    },
    defaultsApplied: resolved.applied
  }
}

/** What a start will actually carry on this server, with the receipt that reports it. */
export function resolveFederatedWorkerLaunch(args: {
  params: WorkerStartInput
  capabilities?: readonly string[]
  defaultsApplied?: OrchestrationWorkerLaunchDefaultsApplied
}): { params: WorkerStartInput; requested: OrchestrationWorkerLaunchReceipt } {
  const params = resolveFederatedWorkerLaunchParams(args)
  return {
    params,
    requested: createPendingWorkerLaunchReceipt({
      agent: isTuiAgent(params.agent) ? params.agent : null,
      model: params.model,
      effort: params.effort
    })
  }
}

export type OrchestrationWorkerLaunchSelection = {
  agent: TuiAgent | null
  model: string | null
  effort: string | null
}

export type OrchestrationWorkerLaunchReceipt = {
  requested: OrchestrationWorkerLaunchSelection
  effective: OrchestrationWorkerLaunchSelection | null
}

export function createWorkerLaunchReceipt(args: {
  agent: TuiAgent | null
  model?: string
  effort?: string
}): OrchestrationWorkerLaunchReceipt {
  const selection = {
    agent: args.agent,
    model: args.model ?? null,
    effort: args.effort ?? null
  }
  return { requested: selection, effective: { ...selection } }
}

/** A chat worker launches with the model and effort its session was seeded with, not only those the caller asked for. */
export function structuredWorkerLaunchReceipt(
  receipt: OrchestrationWorkerLaunchReceipt,
  options: Readonly<Record<string, string>> | undefined
): OrchestrationWorkerLaunchReceipt {
  return {
    ...receipt,
    effective: {
      ...(receipt.effective ?? receipt.requested),
      model: options?.model ?? null,
      effort: options?.effort ?? null
    }
  }
}

/** A reuse start launches nothing; the agent already running there is its effective agent, so
 *  mail from a start that never binds still names it. */
export function reusedWorkerLaunchReceipt(
  runtime: Pick<OrcaRuntimeService, 'orchestrationSenderNames'>,
  receipt: OrchestrationWorkerLaunchReceipt,
  party: AgentMessageSender['party']
): OrchestrationWorkerLaunchReceipt {
  if (receipt.effective?.agent) {
    return receipt
  }
  const running = runtime.orchestrationSenderNames.liveAgentOf(party)
  return isTuiAgent(running)
    ? {
        ...receipt,
        effective: { ...(receipt.effective ?? receipt.requested), agent: running }
      }
    : receipt
}

export function createPendingWorkerLaunchReceipt(args: {
  agent: TuiAgent | null
  model?: string
  effort?: string
}): OrchestrationWorkerLaunchReceipt {
  return {
    requested: {
      agent: args.agent,
      model: args.model ?? null,
      effort: args.effort ?? null
    },
    effective: null
  }
}

export function resolveWorkerLaunchPreferences(args: {
  agent: TuiAgent
  openCodeModelLaunchSupported?: boolean
  createsWorktree?: boolean
  model?: string
  effort?: string
}): {
  preferences: AgentLaunchPreferences | undefined
  receipt: OrchestrationWorkerLaunchReceipt
} {
  const checked = checkAgentLaunchModelPreferences(args)
  if ('refusal' in checked) {
    throw new OrchestrationError(checked.refusal.code, checked.refusal.message)
  }
  const { preferences } = checked
  return {
    preferences,
    receipt: createWorkerLaunchReceipt({ agent: args.agent, ...preferences })
  }
}

export function assertWorkerLaunchPreferencesCreateTerminal(args: {
  terminal?: string
  model?: string
  effort?: string
}): void {
  if (args.terminal && (args.model || args.effort)) {
    throw new OrchestrationError(
      'invalid_argument',
      '--model and --effort cannot be applied when reusing an existing terminal.'
    )
  }
}

export function assertWorkerLaunchPreferencesRuntimeSupported(args: {
  model?: string
  effort?: string
  capabilities?: readonly string[]
  serverName: string
}): void {
  if (
    (args.model || args.effort) &&
    !args.capabilities?.includes(ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY)
  ) {
    throw new OrchestrationError(
      'capability_unsupported',
      `Connected server ${args.serverName} does not support worker model or effort overrides.`
    )
  }
}

export function resolveFederatedWorkerLaunchReceipt(
  remote: OrchestrationWorkerLaunchReceipt | undefined,
  requested: OrchestrationWorkerLaunchReceipt,
  remoteReady: boolean
): OrchestrationWorkerLaunchReceipt {
  if (remote) {
    return remote
  }
  return remoteReady
    ? { requested: requested.requested, effective: { ...requested.requested } }
    : requested
}
