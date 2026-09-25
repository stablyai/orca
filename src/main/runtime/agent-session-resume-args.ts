import type { AgentSessionLaunchArgs } from '../../shared/agent-session-record'
import { quoteStartupArg, type AgentStartupShell } from '../../shared/tui-agent-startup-shell'

export function resolveAgentSessionResumeArgs(input: {
  requestArgs?: string | null
  persistedArgs?: AgentSessionLaunchArgs
  defaultArgs?: string | null
  shell: AgentStartupShell
}): string | null | undefined {
  if (input.requestArgs !== undefined) {
    return input.requestArgs
  }
  if (input.persistedArgs !== undefined) {
    return input.persistedArgs.map((arg) => quoteStartupArg(arg, input.shell)).join(' ')
  }
  return input.defaultArgs
}
