import type { TuiAgent } from '../../../src/shared/tui-agent'
import { orderDetectedTuiAgents } from '../../../src/shared/tui-agent-selection'
import { MOBILE_TUI_AGENT_LABELS } from '../tasks/mobile-tui-agents'

export type MobileNewTabAgentSettings = {
  defaultTuiAgent?: TuiAgent | 'blank' | null
  disabledTuiAgents?: unknown
}

export type MobileNewTabAgentOption = {
  agent: TuiAgent
  label: string
}

export function orderMobileNewTabAgents(
  defaultAgent: TuiAgent | 'blank' | null | undefined,
  detectedAgents: Iterable<unknown>,
  disabledAgents?: unknown
): TuiAgent[] {
  return orderDetectedTuiAgents(defaultAgent, detectedAgents, disabledAgents)
}

export function buildMobileNewTabAgentOptions(
  settings: MobileNewTabAgentSettings | null | undefined,
  detectedAgentIds: Iterable<unknown> | null
): MobileNewTabAgentOption[] {
  if (!detectedAgentIds) {
    return []
  }
  return orderMobileNewTabAgents(
    settings?.defaultTuiAgent,
    detectedAgentIds,
    settings?.disabledTuiAgents
  ).map((agent) => ({
    agent,
    label: MOBILE_TUI_AGENT_LABELS[agent]
  }))
}
