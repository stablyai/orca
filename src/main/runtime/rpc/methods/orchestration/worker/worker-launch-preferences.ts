import type { AgentLaunchPreferences } from '../../../../../../shared/agent-session-host-authority'
import { checkAgentLaunchModelPreferences } from '../../../../../../shared/agent-launch-model-preferences'
import {
  resolveOrchestrationWorkerEffort,
  supportsLaunchModel,
  type OrchestrationWorkerLaunchDefaults
} from '../../../../../../shared/orchestration-worker-model-settings'
import { ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY } from '../../../../../../shared/protocol-version'
import type { TuiAgent } from '../../../../../../shared/tui-agent'
import { isTuiAgent } from '../../../../../../shared/tui-agent-config'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { WorkerStartInput } from './worker-start-schema'

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
