import type { AgentSessionSlashCommand } from '../../shared/agent-session/agent-session-wire'
import { runClaudeListing, type ClaudeModelCatalogProbeDeps } from './claude-model-catalog-probe'
import { ClaudeSlashCommandCatalog } from './claude-slash-command-catalog'
import { readClaudeControlResponses } from './claude-control-responses'

const REQUEST_ID = 'orca-command-discovery'

// initialize lists the live chat command surface without spending an API turn.
const CLAUDE_COMMAND_LIST_STDIN = `${JSON.stringify({
  type: 'control_request',
  request_id: REQUEST_ID,
  request: { subtype: 'initialize' }
})}\n`

export type ClaudeCommandCatalogProbe = (request: {
  cwd: string
  accountHomePath: string
  signal?: AbortSignal
  isCurrent?: () => boolean
}) => Promise<AgentSessionSlashCommand[]>

export function createClaudeCommandCatalogProbe(
  deps: ClaudeModelCatalogProbeDeps
): ClaudeCommandCatalogProbe {
  return async ({ cwd, accountHomePath, isCurrent, signal }) => {
    const stdout = await runClaudeListing(deps, {
      accountHomePath,
      cwd,
      stdin: CLAUDE_COMMAND_LIST_STDIN,
      site: 'claude-command-catalog-probe',
      isCurrent,
      signal
    })
    const commands = readInitializeCommands(stdout)
    if (!commands?.length) {
      throw new Error('claude listed no commands')
    }
    return commands
  }
}

function readInitializeCommands(stdout: string): AgentSessionSlashCommand[] | undefined {
  const initialization = readClaudeControlResponses(stdout).get(REQUEST_ID)
  return initialization === undefined
    ? undefined
    : new ClaudeSlashCommandCatalog(undefined, initialization).commands
}
