import { structuredAgentArgTokens } from '../../native-chat/structured-agent-configured-args'
import { isAgentSessionLaunchArgs } from '../../../shared/agent-session/lifecycle/agent-session-launch-args'
import type { StructuredAgentId } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle'
import type { GlobalSettings } from '../../../shared/global-settings-types'

/** The continued terminal's arguments, split as its shell did; ones that do not fit a record stay behind. */
export function structuredSessionSourceTerminalArgs(
  agent: StructuredAgentId,
  agentArgs: string | undefined,
  settings: Partial<Pick<GlobalSettings, 'terminalWindowsShell'>>
): { sourceTerminalArgs: string[] } | Record<string, never> {
  if (!agentArgs?.trim()) {
    return {}
  }
  let tokens: string[]
  try {
    tokens = structuredAgentArgTokens(agent, agentArgs, settings)
  } catch {
    return {}
  }
  return tokens.length && isAgentSessionLaunchArgs(tokens) ? { sourceTerminalArgs: tokens } : {}
}
