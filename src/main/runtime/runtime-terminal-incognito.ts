import { isTuiAgent } from '../../shared/tui-agent-config'
import { isIncognitoCapable } from '../../shared/tui-agent-incognito'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { TerminalCreateOptions } from './runtime-terminal-contracts'

/**
 * Resolves whether a terminal being created should be incognito ("no-session"): no scrollback is
 * persisted to disk. Precedence:
 *   1. An explicit per-terminal `opts.incognito` (the `orca terminal create --no-session` flag) wins,
 *      including an explicit `false` that overrides an agent default.
 *   2. Otherwise, the per-agent default: the agent this terminal launches is listed in
 *      Settings.terminalIncognitoAgents ("mark this agent incognito by default").
 *   3. Otherwise not incognito.
 *
 * `launchOpts` carries the agent actually resolved for launch (startupAgent → launchAgent); the raw
 * `opts` is consulted too so a caller that only set `startupAgent` still matches an agent default.
 */
export function resolveTerminalIncognito(
  opts: Pick<TerminalCreateOptions, 'incognito' | 'launchAgent' | 'startupAgent'>,
  launchOpts: Pick<TerminalCreateOptions, 'launchAgent' | 'startupAgent'>,
  getSettings: () => Pick<GlobalSettings, 'terminalIncognitoAgents'> | undefined
): boolean {
  if (typeof opts.incognito === 'boolean') {
    return opts.incognito
  }
  const configured = getSettings()?.terminalIncognitoAgents
  if (!configured || configured.length === 0) {
    return false
  }
  const agent =
    launchOpts.startupAgent ?? launchOpts.launchAgent ?? opts.startupAgent ?? opts.launchAgent
  if (agent === undefined || !isTuiAgent(agent)) {
    return false
  }
  // Why: the per-agent default is only honest for agents that can be made ephemeral. A non-capable
  // agent (e.g. claude) must never default to incognito even if a stale setting still lists it.
  if (!isIncognitoCapable(agent)) {
    return false
  }
  return configured.includes(agent)
}
