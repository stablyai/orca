import { extractLeadingEnvAssignments } from '../../../shared/command-environment'
import { getCommandTokenPathBasename } from '../../../shared/command-token-scanner'
import type { TuiAgent } from '../../../shared/tui-agent'
import { isTuiAgent } from '../../../shared/tui-agent-config'
import {
  resolveStartupShell,
  type AgentStartupShell,
  tokenizeStartupCommand
} from '../../../shared/tui-agent-startup-shell'
import { OrchestrationError } from './orchestration-error'

export function resolveConfiguredWorkerAgent(
  selector: string,
  overrides: Partial<Record<TuiAgent, string>>,
  platform: NodeJS.Platform = process.platform,
  shell?: AgentStartupShell
): TuiAgent | undefined {
  if (isTuiAgent(selector)) {
    return selector
  }
  const matches: TuiAgent[] = []
  for (const [agent, command] of Object.entries(overrides)) {
    if (!isTuiAgent(agent) || !command) {
      continue
    }
    const parsed = tokenizeStartupCommand(command, resolveStartupShell(platform, shell))
    // A command wrapper cannot attest which CLI grammar its arguments implement.
    if (
      !parsed.ok ||
      parsed.tokens.length !== 1 ||
      parsed.spans.some((span) => span.divergesFromShell)
    ) {
      continue
    }
    if (extractLeadingEnvAssignments(parsed.tokens).env) {
      continue
    }
    const executable = parsed.tokens[0]
    const name = getCommandTokenPathBasename(executable).replace(/\.(?:exe|cmd|bat)$/i, '')
    if (name === selector) {
      matches.push(agent)
    }
  }
  if (matches.length > 1) {
    throw new OrchestrationError(
      'agent_unconfigured',
      `Agent command ${selector} is configured for multiple launchers. Use a canonical agent ID.`
    )
  }
  return matches[0]
}
