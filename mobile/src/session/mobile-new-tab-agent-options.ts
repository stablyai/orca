import type { BuiltInTuiAgent, TuiAgent } from '../../../src/shared/types'
import type { AgentCatalogValue } from '../transport/agent-catalog-sync'
import { buildMobileAgentPickerRows } from '../tasks/mobile-agent-catalog-projection'
import {
  filterEnabledMobileTuiAgents,
  isMobileTuiAgent,
  MOBILE_TUI_AGENT_AUTO_PICK_ORDER
} from '../tasks/mobile-tui-agents'

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
): BuiltInTuiAgent[] {
  const detected = new Set([...detectedAgents].filter(isMobileTuiAgent))
  const enabledDetected = filterEnabledMobileTuiAgents(
    MOBILE_TUI_AGENT_AUTO_PICK_ORDER,
    disabledAgents
  ).filter((agent) => detected.has(agent))

  if (
    defaultAgent &&
    defaultAgent !== 'blank' &&
    isMobileTuiAgent(defaultAgent) &&
    enabledDetected.includes(defaultAgent)
  ) {
    return [defaultAgent, ...enabledDetected.filter((agent) => agent !== defaultAgent)]
  }
  return enabledDetected
}

export function buildMobileNewTabAgentOptions(
  settings: MobileNewTabAgentSettings | null | undefined,
  detectedAgentIds: Iterable<unknown> | null,
  catalogSnapshot: AgentCatalogValue | null = null
): MobileNewTabAgentOption[] {
  if (!detectedAgentIds) {
    return []
  }
  const detected = new Set([...detectedAgentIds].filter(isMobileTuiAgent))
  const options = buildMobileAgentPickerRows(catalogSnapshot, {
    includeCustomAgents: true
  })
    .filter((row) => {
      if (row.isCustom) {
        return row.baseAgent !== undefined && detected.has(row.baseAgent)
      }
      return (
        detected.has(row.id as BuiltInTuiAgent) &&
        filterEnabledMobileTuiAgents([row.id], settings?.disabledTuiAgents).length > 0
      )
    })
    .map((row) => ({ agent: row.id, label: row.label }))
  const preferred = settings?.defaultTuiAgent
  if (!preferred || preferred === 'blank') {
    return options
  }
  const preferredIndex = options.findIndex((option) => option.agent === preferred)
  if (preferredIndex <= 0) {
    return options
  }
  return [options[preferredIndex]!, ...options.filter((_, index) => index !== preferredIndex)]
}
