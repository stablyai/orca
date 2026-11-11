import type { TuiAgent } from '../../../../src/shared/agent-launch/catalog/tui-agent'
import { filterEnabledMobileTuiAgents } from '../../tasks/mobile-tui-agents'
import { isTuiAgent as isMobileTuiAgent } from '../../../../src/shared/agent-launch/catalog/tui-agent-config'
import { TUI_AGENT_AUTO_PICK_ORDER as MOBILE_TUI_AGENT_AUTO_PICK_ORDER } from '../../../../src/shared/agent-launch/catalog/tui-agent-selection'
import { TUI_AGENT_DISPLAY_NAMES as MOBILE_TUI_AGENT_LABELS } from '../../../../src/shared/agent-launch/catalog/tui-agent-display-names'

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
  const detected = new Set([...detectedAgents].filter(isMobileTuiAgent))
  const enabledDetected = filterEnabledMobileTuiAgents(
    MOBILE_TUI_AGENT_AUTO_PICK_ORDER,
    disabledAgents
  ).filter((agent) => detected.has(agent))

  if (defaultAgent && defaultAgent !== 'blank' && enabledDetected.includes(defaultAgent)) {
    return [defaultAgent, ...enabledDetected.filter((agent) => agent !== defaultAgent)]
  }
  return enabledDetected
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
