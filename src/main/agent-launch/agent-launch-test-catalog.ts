// Test fixtures for the agent-launch resolver: catalog/settings/request builders
// shared across the lifecycle, assembly, and env suites. Not a test file.

import type {
  BuiltInTuiAgent,
  CustomTuiAgent,
  CustomTuiAgentId,
  DeletedCustomTuiAgent,
  GlobalSettings,
  TuiAgent
} from '../../shared/types'
import { normalizeAgentCatalog, type AgentCatalog } from '../../shared/agent-catalog-normalization'
import type {
  AgentLaunchExecutionHostId,
  AgentReferenceAuthority,
  LaunchIntent,
  ResolveAgentLaunchRequest
} from '../../shared/agent-launch-host-contract'

let uuidCounter = 0
function nextUuid(): string {
  uuidCounter += 1
  const hex = uuidCounter.toString(16).padStart(12, '0')
  return `00000000-0000-4000-8000-${hex}`
}

export function customId(base: BuiltInTuiAgent, suffix?: string): CustomTuiAgentId {
  return `custom-agent:${base}:${suffix ?? nextUuid()}`
}

export function customAgent(
  overrides: Partial<CustomTuiAgent> & { id: CustomTuiAgentId }
): CustomTuiAgent {
  return {
    baseAgent: 'claude',
    label: 'My Agent',
    args: '',
    env: {},
    syncEnv: false,
    ...overrides
  }
}

export function tombstone(
  overrides: Partial<DeletedCustomTuiAgent> & { id: CustomTuiAgentId }
): DeletedCustomTuiAgent {
  return { baseAgent: 'claude', label: 'Deleted Agent', deletedAt: 1, ...overrides }
}

export function catalogOf(input: {
  customTuiAgents?: CustomTuiAgent[]
  deletedCustomTuiAgents?: DeletedCustomTuiAgent[]
  disabledTuiAgents?: TuiAgent[]
  defaultTuiAgent?: TuiAgent | 'auto' | 'blank' | null
}): AgentCatalog {
  return normalizeAgentCatalog({
    customTuiAgents: input.customTuiAgents ?? [],
    deletedCustomTuiAgents: input.deletedCustomTuiAgents ?? [],
    disabledTuiAgents: input.disabledTuiAgents ?? [],
    // Preserve an explicit null (repair-needed default); only absent means auto.
    defaultTuiAgent: 'defaultTuiAgent' in input ? input.defaultTuiAgent : 'auto'
  }).catalog
}

export function settingsOf(overrides?: {
  agentCmdOverrides?: Partial<Record<BuiltInTuiAgent, string>>
  agentDefaultArgs?: Partial<Record<BuiltInTuiAgent, string>>
  agentDefaultEnv?: Partial<Record<BuiltInTuiAgent, Record<string, string>>>
}): GlobalSettings {
  return {
    agentCmdOverrides: overrides?.agentCmdOverrides ?? {},
    agentDefaultArgs: overrides?.agentDefaultArgs ?? {},
    agentDefaultEnv: overrides?.agentDefaultEnv ?? {}
  } as unknown as GlobalSettings
}

export const INTERACTIVE_DESKTOP: LaunchIntent = { kind: 'interactive', client: 'desktop' }
export const PERSISTED_DEFAULT: AgentReferenceAuthority = { kind: 'persisted', owner: 'default' }
export const LIVE_SELECTION: AgentReferenceAuthority = { kind: 'live-selection' }

export function requestOf(
  overrides: Partial<ResolveAgentLaunchRequest> & {
    selection: ResolveAgentLaunchRequest['selection']
  }
): ResolveAgentLaunchRequest {
  return {
    intent: INTERACTIVE_DESKTOP,
    reference: LIVE_SELECTION,
    variables: {},
    platform: 'linux',
    isRemote: false,
    targetHomePath: '/home/dev',
    detectedStockBaseAgents: null,
    executionHostId: 'local' as AgentLaunchExecutionHostId,
    ...overrides
  }
}

/** All base built-ins detected — a concrete non-empty detection set. */
export function allDetected(...agents: BuiltInTuiAgent[]): ReadonlySet<BuiltInTuiAgent> {
  return new Set(agents)
}
