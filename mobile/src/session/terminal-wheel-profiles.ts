import type { TuiWheelProfile } from '../terminal/document/tui-wheel-pacing'
import type { MobileSessionTab } from './mobile-session-route-types'
import { resolveMobileTerminalTabAgentId } from './mobile-terminal-tab-agent'

/**
 * The wheel profile of each terminal handle whose program reads wheel reports differently: Claude
 * Code, which reads a report's rows from its spacing (see tui-wheel-pacing), and Codex, which
 * scrolls only for reports over its history. Every other terminal moves one row per report
 * wherever it is reported.
 */
export function terminalWheelProfiles(
  tabs: readonly MobileSessionTab[]
): ReadonlyMap<string, TuiWheelProfile> {
  const profiles = new Map<string, TuiWheelProfile>()
  for (const tab of tabs) {
    if (tab.type !== 'terminal' || !tab.terminal) {
      continue
    }
    const agent = resolveMobileTerminalTabAgentId(tab)
    if (agent === 'claude') {
      profiles.set(tab.terminal, 'claude-code')
    } else if (agent === 'codex') {
      profiles.set(tab.terminal, 'codex')
    }
  }
  return profiles
}
