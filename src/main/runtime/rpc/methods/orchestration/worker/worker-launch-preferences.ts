import { createHash } from 'node:crypto'
import type { AgentLaunchPreferences } from '../../../../../../shared/agent-session-host-authority'
import {
  findCatalogModel,
  findCatalogOption,
  getAgentSessionOptionCatalog
} from '../../../../../../shared/agent-session-option-catalog'
import { resolveAgentSessionOptionLaunch } from '../../../../../../shared/agent-session-option-launch'
import { ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY } from '../../../../../../shared/protocol-version'
import type { TuiAgent } from '../../../../../../shared/tui-agent'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../../../../shared/tui-agent-launch-defaults'
import {
  resolveTuiAgentPermissionMode,
  type AgentPermissionMode
} from '../../../../../../shared/tui-agent-permissions'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'

export type OrchestrationWorkerLaunchSelection = {
  agent: TuiAgent | null
  model: string | null
  effort: string | null
  // Why: composing --model/--effort must never silently flip a configured
  // manual agent to yolo or vice versa — carrying the mode alongside the
  // selection lets a receipt reader prove the composition preserved it.
  permissionMode: AgentPermissionMode | null
  // Why: the exact command a caller can reproduce is only known once a
  // terminal/host resolves; null here (both requested and effective) until
  // attachWorkerLaunchExecutable fills it in from the real ManagedCliContext
  // or getTerminalOrchestrationCliCommand result.
  executable: string | null
  serviceTier: 'default' | 'fast' | null
  environmentPolicy: string | null
}

export type OrchestrationWorkerLaunchReceipt = {
  requested: OrchestrationWorkerLaunchSelection
  effective: OrchestrationWorkerLaunchSelection | null
}

/** The agent's configured permission mode from global settings, independent of any per-request model/effort. */
export function resolveRequestedAgentPermissionMode(
  agent: TuiAgent | null,
  settings?: {
    agentDefaultArgs?: Partial<Record<TuiAgent, string>> | null
    agentDefaultEnv?: Partial<Record<TuiAgent, Record<string, string>>> | null
  }
): AgentPermissionMode | null {
  if (!agent) {
    return null
  }
  return resolveTuiAgentPermissionMode({
    agent,
    agentArgs: resolveTuiAgentLaunchArgs(agent, settings?.agentDefaultArgs),
    agentEnv: resolveTuiAgentLaunchEnv(agent, settings?.agentDefaultEnv)
  })
}

/** Fills in the executable once a terminal/host resolves it; a no-op on a still-pending (effective === null) receipt. */
export function attachWorkerLaunchExecutable(
  receipt: OrchestrationWorkerLaunchReceipt,
  executable: string | null
): void {
  if (receipt.effective) {
    receipt.effective.executable = executable
  }
}

export function createWorkerLaunchReceipt(args: {
  agent: TuiAgent | null
  model?: string
  effort?: string
  permissionMode?: AgentPermissionMode | null
  executable?: string | null
  serviceTier?: 'default' | 'fast' | null
  environmentPolicy?: string | null
}): OrchestrationWorkerLaunchReceipt {
  const selection = {
    agent: args.agent,
    model: args.model ?? null,
    effort: args.effort ?? null,
    permissionMode: args.permissionMode ?? null,
    executable: args.executable ?? null,
    serviceTier: args.serviceTier ?? (args.agent === 'codex' ? 'default' : null),
    environmentPolicy: args.environmentPolicy ?? null
  }
  return { requested: selection, effective: { ...selection } }
}

export function createPendingWorkerLaunchReceipt(args: {
  agent: TuiAgent | null
  model?: string
  effort?: string
  permissionMode?: AgentPermissionMode | null
  serviceTier?: 'default' | 'fast' | null
  environmentPolicy?: string | null
}): OrchestrationWorkerLaunchReceipt {
  return {
    requested: {
      agent: args.agent,
      model: args.model ?? null,
      effort: args.effort ?? null,
      permissionMode: args.permissionMode ?? null,
      executable: null,
      serviceTier: args.serviceTier ?? (args.agent === 'codex' ? 'default' : null),
      environmentPolicy: args.environmentPolicy ?? null
    },
    effective: null
  }
}

export function resolveWorkerLaunchPreferences(args: {
  agent: TuiAgent
  model?: string
  effort?: string
  settings?: {
    agentDefaultArgs?: Partial<Record<TuiAgent, string>> | null
    agentDefaultEnv?: Partial<Record<TuiAgent, Record<string, string>>> | null
  }
}): {
  preferences: AgentLaunchPreferences | undefined
  receipt: OrchestrationWorkerLaunchReceipt
} {
  const permissionMode = resolveRequestedAgentPermissionMode(args.agent, args.settings)
  const serviceTier = args.agent === 'codex' ? ('default' as const) : null
  const environmentPolicy = resolveAgentEnvironmentPolicy(args.agent, args.settings)
  if (args.effort && !args.model) {
    throw new OrchestrationError('invalid_argument', '--effort requires --model.')
  }
  if (!args.model) {
    return {
      preferences: {
        ...(serviceTier ? { serviceTier } : {}),
        environmentPolicy
      },
      receipt: createWorkerLaunchReceipt({
        agent: args.agent,
        permissionMode,
        serviceTier,
        environmentPolicy
      })
    }
  }

  const catalog = getAgentSessionOptionCatalog(args.agent)
  if (!catalog?.supportsWorkerLaunchPreferences || !catalog.modelApply.launchArgs) {
    throw new OrchestrationError(
      'invalid_argument',
      `Agent ${args.agent} does not support launch-time model selection.`
    )
  }

  if (args.effort) {
    const model = findCatalogModel(catalog, args.model)
    const option =
      findCatalogOption(model, 'effort') ??
      (!model
        ? catalog.unknownModelOptions?.find((candidate) => candidate.id === 'effort')
        : undefined)
    if (
      option?.kind.type !== 'select' ||
      !option.kind.choices.some((choice) => choice.value === args.effort)
    ) {
      throw new OrchestrationError(
        'invalid_argument',
        `Agent ${args.agent} model ${args.model} does not support effort ${args.effort}.`
      )
    }
  }

  const requested = {
    model: args.model,
    ...(args.effort ? { effort: args.effort } : {})
  }
  const resolved = resolveAgentSessionOptionLaunch(args.agent, requested, [], false)
  if (
    resolved.appliedValues.model !== args.model ||
    resolved.appliedValues.effort !== args.effort
  ) {
    throw new OrchestrationError(
      'invalid_argument',
      `Agent ${args.agent} cannot apply the requested worker launch preferences.`
    )
  }

  const preferences: AgentLaunchPreferences = {
    ...requested,
    ...(serviceTier ? { serviceTier } : {}),
    environmentPolicy
  }
  return {
    preferences,
    receipt: createWorkerLaunchReceipt({
      agent: args.agent,
      ...preferences,
      permissionMode,
      serviceTier,
      environmentPolicy
    })
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
  _remoteReady: boolean
): OrchestrationWorkerLaunchReceipt {
  if (remote) {
    return remote.effective &&
      launchSelectionsMatch(remote.requested, requested.requested) &&
      launchSelectionsMatch(remote.effective, requested.requested)
      ? { requested: requested.requested, effective: remote.effective }
      : requested
  }
  return requested
}

function resolveAgentEnvironmentPolicy(
  agent: TuiAgent,
  settings?: {
    agentDefaultEnv?: Partial<Record<TuiAgent, Record<string, string>>> | null
  }
): string {
  const environment = Object.entries(
    resolveTuiAgentLaunchEnv(agent, settings?.agentDefaultEnv)
  ).sort(([left], [right]) => left.localeCompare(right))
  return `sha256:${createHash('sha256').update(JSON.stringify(environment)).digest('hex')}`
}

function launchSelectionsMatch(
  left: OrchestrationWorkerLaunchSelection,
  right: OrchestrationWorkerLaunchSelection
): boolean {
  return (
    left.agent === right.agent &&
    left.model === right.model &&
    left.effort === right.effort &&
    left.permissionMode === right.permissionMode &&
    left.serviceTier === right.serviceTier &&
    left.environmentPolicy === right.environmentPolicy
  )
}
