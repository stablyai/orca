import { structuredAgentArgTokens } from '../../../native-chat/agent-launch/structured-agent-configured-args'
import { isAgentSessionLaunchArgs } from '../../../../shared/agent-session/lifecycle/records/agent-session-launch-args'
import type { StructuredAgentId } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle'
import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'

/** The continued terminal's arguments, split as its shell did; ones that do not fit a record stay behind. */
export function structuredSessionSourceTerminalArgs(
  agent: StructuredAgentId,
  resumeFrom: { agentArgs?: string } | undefined,
  settings: Partial<Pick<GlobalSettings, 'terminalWindowsShell'>>
): { sourceTerminalArgs: string[] } | Record<string, never> {
  const agentArgs = resumeFrom?.agentArgs
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
