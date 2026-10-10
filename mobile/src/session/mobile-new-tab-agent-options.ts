import { isAgentSessionHandleProvider } from '../../../src/shared/agent-session-provider-handle'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import type { TuiAgent } from '../../../src/shared/tui-agent'
import {
  filterEnabledMobileTuiAgents,
  isMobileTuiAgent,
  MOBILE_TUI_AGENT_AUTO_PICK_ORDER,
  MOBILE_TUI_AGENT_LABELS
} from '../tasks/mobile-tui-agents'

export type MobileNewTabAgentSettings = {
  defaultTuiAgent?: TuiAgent | 'blank' | null
  disabledTuiAgents?: unknown
  experimentalNativeChat?: boolean
}

export type MobileNewTabAgentMode = 'chat' | 'terminal'

export type MobileNewTabAgentOption = {
  agent: TuiAgent
  label: string
  mode: MobileNewTabAgentMode
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

function agentSupportsNativeChatOption(
  agent: TuiAgent,
  settings: MobileNewTabAgentSettings | null | undefined,
  hostCapabilities: readonly string[] | undefined
): boolean {
  if (!isAgentSessionHandleProvider(agent)) {
    return false
  }
  if (settings?.experimentalNativeChat !== true) {
    return false
  }
  return hostCapabilities?.includes(STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY) === true
}

export function buildMobileNewTabAgentOptions(
  settings: MobileNewTabAgentSettings | null | undefined,
  detectedAgentIds: Iterable<unknown> | null,
  hostCapabilities?: readonly string[] | null
): MobileNewTabAgentOption[] {
  if (!detectedAgentIds) {
    return []
  }
  const ordered = orderMobileNewTabAgents(
    settings?.defaultTuiAgent,
    detectedAgentIds,
    settings?.disabledTuiAgents
  )
  const capabilities = hostCapabilities ?? []
  const options: MobileNewTabAgentOption[] = []
  for (const agent of ordered) {
    const label = MOBILE_TUI_AGENT_LABELS[agent]
    // Why: the terminal option is always offered so the '+' menu can launch Claude Code in a
    // PTY even when the desktop default is a structured chat session.
    options.push({ agent, label, mode: 'terminal' })
    if (agentSupportsNativeChatOption(agent, settings, capabilities)) {
      options.push({ agent, label: `${label} Chat`, mode: 'chat' })
    }
  }
  return options
}
