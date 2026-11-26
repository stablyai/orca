// What a worker's agent lacks on the computer that runs it, named as this Orca calls that computer:
// a paired server's name for its workers, "this computer" for this Orca's own.
import { TUI_AGENT_DISPLAY_NAMES } from '../../../../../shared/agent-launch/catalog/tui-agent-display-names'
import { isTuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent-config'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import { agentSessionSignInCommand } from '../../../../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'

export const THIS_COMPUTER = 'this computer'

function agentName(agent: TuiAgent): string {
  return TUI_AGENT_DISPLAY_NAMES[agent] ?? agent
}

export function workerAgentNotInstalledMessage(agent: TuiAgent, computer: string): string {
  const name = agentName(agent)
  return `${name} isn't installed on ${computer}, so no worker was started there. Install ${name} on ${computer}, or start the worker with another --agent.`
}

/** Null for a value that names no agent Orca launches. */
export function workerAgentSignInMessage(agent: unknown, computer: string): string | null {
  if (!isTuiAgent(agent)) {
    return null
  }
  // Signed in from another computer, so a browser login's localhost redirect would land on the wrong one.
  const login = agentSessionSignInCommand(agent, { remote: true })
  return `${agentName(agent)} on ${computer} isn't signed in${login ? `: run \`${login}\` there` : ''}.`
}

/** A worker report's sign-in line, from the facts its payload carries; null for any other report. */
export function workerReportSignInMessage(payload: string | null, computer: string): string | null {
  let facts: unknown
  try {
    facts = payload ? JSON.parse(payload) : null
  } catch {
    return null
  }
  if (typeof facts !== 'object' || facts === null) {
    return null
  }
  const kind = 'failureKind' in facts ? facts.failureKind : undefined
  return kind === 'notSignedIn' && 'agent' in facts
    ? workerAgentSignInMessage(facts.agent, computer)
    : null
}
