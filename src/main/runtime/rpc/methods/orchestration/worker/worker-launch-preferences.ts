import type { AgentLaunchPreferences } from '../../../../../../shared/agent-session-host-authority'
import { checkAgentLaunchModelPreferences } from '../../../../../../shared/agent-launch-model-preferences'
import {
  ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY,
  ORCHESTRATION_WORKER_ROLE_ROUTING_RUNTIME_CAPABILITY
} from '../../../../../../shared/protocol-version'
import type { TuiAgent } from '../../../../../../shared/tui-agent'
import { isTuiAgent } from '../../../../../../shared/tui-agent-config'
import { z } from 'zod'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'

export type OrchestrationWorkerLaunchSelection = {
  agent: TuiAgent | null
  model: string | null
  effort: string | null
  fastMode?: boolean
  serviceTier?: string
}

export type OrchestrationWorkerLaunchReceipt = {
  role?: string
  effectiveSource?: 'launch_configuration'
  requested: OrchestrationWorkerLaunchSelection
  effective: OrchestrationWorkerLaunchSelection | null
}

const PreflightSelection = z.object({
  agent: z.custom<TuiAgent>((value) => typeof value === 'string' && isTuiAgent(value)),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  fastMode: z.boolean().optional(),
  serviceTier: z.string().optional()
})

export function parseWorkerLaunchPreflight(value: unknown): OrchestrationWorkerLaunchReceipt {
  const parsed = z
    .object({
      launch: z.object({
        role: z.string().optional(),
        requested: PreflightSelection,
        effective: z.null()
      })
    })
    .safeParse(value)
  if (!parsed.success) {
    throw new OrchestrationError(
      'capability_unsupported',
      'The execution host returned an invalid launch preflight receipt. No effects were applied.',
      { effectsApplied: false }
    )
  }
  return parsed.data.launch
}

export function createWorkerLaunchReceipt(args: {
  agent: TuiAgent | null
  model?: string
  effort?: string
  fastMode?: boolean
  serviceTier?: string
  role?: string
}): OrchestrationWorkerLaunchReceipt {
  const selection = {
    agent: args.agent,
    model: args.model ?? null,
    effort: args.effort ?? null,
    ...(args.fastMode !== undefined ? { fastMode: args.fastMode } : {}),
    ...(args.serviceTier !== undefined ? { serviceTier: args.serviceTier } : {})
  }
  return {
    ...(args.role ? { role: args.role } : {}),
    ...(args.role || args.fastMode !== undefined
      ? { effectiveSource: 'launch_configuration' as const }
      : {}),
    requested: selection,
    effective: { ...selection }
  }
}

export function createPendingWorkerLaunchReceipt(args: {
  agent: TuiAgent | null
  model?: string
  effort?: string
  fastMode?: boolean
  role?: string
}): OrchestrationWorkerLaunchReceipt {
  return {
    ...(args.role ? { role: args.role } : {}),
    requested: {
      agent: args.agent,
      model: args.model ?? null,
      effort: args.effort ?? null,
      ...(args.fastMode !== undefined ? { fastMode: args.fastMode } : {})
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
  fastMode?: boolean
  role?: string
  structuredFastModeSupported?: boolean
  structuredFastServiceTier?: string
}): {
  preferences: AgentLaunchPreferences | undefined
  receipt: OrchestrationWorkerLaunchReceipt
} {
  const structuredFast =
    args.structuredFastModeSupported === true && (args.agent === 'claude' || args.agent === 'codex')
  if (
    structuredFast &&
    args.agent === 'codex' &&
    args.fastMode !== undefined &&
    !args.structuredFastServiceTier
  ) {
    throw new OrchestrationError(
      'capability_unsupported',
      'Codex Fast requires a verified service tier. No effects were applied.',
      { effectsApplied: false }
    )
  }
  const checked = checkAgentLaunchModelPreferences({
    ...args,
    fastMode: structuredFast ? undefined : args.fastMode
  })
  if ('refusal' in checked) {
    throw new OrchestrationError(checked.refusal.code, checked.refusal.message)
  }
  const preferences =
    structuredFast && args.fastMode !== undefined
      ? {
          ...checked.preferences,
          ...(args.agent === 'codex'
            ? { serviceTier: args.structuredFastServiceTier }
            : { fastMode: args.fastMode })
        }
      : checked.preferences
  return {
    preferences,
    receipt: createWorkerLaunchReceipt({
      agent: args.agent,
      role: args.role,
      ...preferences,
      ...(args.fastMode !== undefined ? { fastMode: args.fastMode } : {})
    })
  }
}

export function assertWorkerLaunchPreferencesCreateTerminal(args: {
  terminal?: string
  model?: string
  effort?: string
  fastMode?: boolean
  role?: string
}): void {
  if (args.terminal && (args.role || args.model || args.effort || args.fastMode !== undefined)) {
    throw new OrchestrationError(
      'invalid_argument',
      '--role, --model and --effort or --fast cannot be applied when reusing an existing terminal.'
    )
  }
}

export function assertWorkerLaunchPreferencesRuntimeSupported(args: {
  model?: string
  effort?: string
  fastMode?: boolean
  role?: string
  capabilities?: readonly string[]
  serverName: string
}): void {
  if (
    (args.role || args.fastMode !== undefined) &&
    !args.capabilities?.includes(ORCHESTRATION_WORKER_ROLE_ROUTING_RUNTIME_CAPABILITY)
  ) {
    throw new OrchestrationError(
      'capability_unsupported',
      `Connected server ${args.serverName} does not support worker roles or Fast launch options. No effects were applied.`,
      { effectsApplied: false }
    )
  }
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
  if (requested.role || requested.requested.fastMode !== undefined) {
    if (!remote || remote.role !== requested.role || (remoteReady && !remote.effective)) {
      throw new Error(
        'The worker server did not return a verifiable role launch receipt; do not retry the Task.'
      )
    }
    const actual = remoteReady ? remote.effective : remote.requested
    if (
      !actual ||
      actual.agent !== requested.requested.agent ||
      actual.model !== requested.requested.model ||
      actual.effort !== requested.requested.effort ||
      actual.fastMode !== requested.requested.fastMode ||
      actual.serviceTier !== requested.requested.serviceTier
    ) {
      throw new Error(
        'The worker server returned different effective launch options; inspect the existing Dispatch before taking further action.'
      )
    }
  }
  if (remote) {
    return remote
  }
  return remoteReady
    ? { requested: requested.requested, effective: { ...requested.requested } }
    : requested
}
