import {
  agentLaunchProfilesForAgent,
  normalizeAgentLaunchProfileSettings,
  resolveAgentLaunchProfiles
} from '../../../src/shared/agent-launch-profile/agent-launch-profile'
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
  agentLaunchProfiles?: unknown
}

export type MobileNewTabAgentOption = {
  agent: TuiAgent
  label: string
  /** Set on launch-profile rows; the default launch of an agent carries none. */
  launchProfileId?: string
  hint?: string
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
  detectedAgentIds: Iterable<unknown> | null,
  options: { launchProfilesSupported?: boolean } = {}
): MobileNewTabAgentOption[] {
  if (!detectedAgentIds) {
    return []
  }
  // Why: only a host that advertises the capability resolves profile ids; an older host would
  // ignore the field and silently start the default launch under the profile's name.
  const profiles = options.launchProfilesSupported
    ? resolveAgentLaunchProfiles(normalizeAgentLaunchProfileSettings(settings?.agentLaunchProfiles))
    : []
  return orderMobileNewTabAgents(
    settings?.defaultTuiAgent,
    detectedAgentIds,
    settings?.disabledTuiAgents
  ).flatMap((agent) => {
    const agentLabel = MOBILE_TUI_AGENT_LABELS[agent]
    return [
      { agent, label: agentLabel },
      ...agentLaunchProfilesForAgent(profiles, agent).map((profile) => ({
        agent,
        label: profile.label,
        launchProfileId: profile.id,
        hint: `${agentLabel} launch profile`
      }))
    ]
  })
}
