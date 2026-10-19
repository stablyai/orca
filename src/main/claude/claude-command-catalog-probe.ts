import type { AgentSessionSlashCommand } from '../../shared/agent-session-wire'
import { CLAUDE_MODEL_LIST_ARGS } from '../../shared/claude-model-list-probe'
import { assertJsonTextStructureWithinLimits } from '../../shared/json-text-structure-limit'
import { runClaudeListing, type ClaudeModelCatalogProbeDeps } from './claude-model-catalog-probe'
import { ClaudeSlashCommandCatalog } from './claude-slash-command-catalog'

const REQUEST_ID = 'orca-command-discovery'

// Why: `initialize` answers the session's `/` surface (built-ins, commands, skills, plugins) with
// no API turn, the same list a live chat seeds its menu from.
const CLAUDE_COMMAND_LIST_STDIN = `${JSON.stringify({
  type: 'control_request',
  request_id: REQUEST_ID,
  request: { subtype: 'initialize' }
})}\n`

// Hooks and MCP servers only slow the answer: a SessionStart hook would run on every refresh,
// and every configured MCP server would start just to be stopped.
const CLAUDE_COMMAND_LIST_ARGS = [
  ...CLAUDE_MODEL_LIST_ARGS,
  '--strict-mcp-config',
  '--settings',
  JSON.stringify({ disableAllHooks: true })
]

const INITIALIZE_JSON_LIMITS = { structuralTokens: 64 * 1024, nestingDepth: 16 } as const

export type ClaudeCommandCatalogProbe = (request: {
  cwd: string
  accountHomePath: string
}) => Promise<AgentSessionSlashCommand[]>

/** Asks Claude, in the folder a chat launches in, what its `/` menu holds. */
export function createClaudeCommandCatalogProbe(
  deps: ClaudeModelCatalogProbeDeps
): ClaudeCommandCatalogProbe {
  return async ({ cwd, accountHomePath }) => {
    const stdout = await runClaudeListing(deps, {
      accountHomePath,
      cwd,
      args: CLAUDE_COMMAND_LIST_ARGS,
      stdin: CLAUDE_COMMAND_LIST_STDIN,
      site: 'claude-command-catalog-probe'
    })
    const commands = readInitializeCommands(stdout)
    // A CLI whose `initialize` answers no commands answers nothing the menu can use.
    if (!commands?.length) {
      throw new Error('claude listed no commands')
    }
    return commands
  }
}

function readInitializeCommands(stdout: string): AgentSessionSlashCommand[] | undefined {
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line.startsWith('{') || !line.includes(REQUEST_ID)) {
      continue
    }
    let parsed: unknown
    try {
      assertJsonTextStructureWithinLimits(line, INITIALIZE_JSON_LIMITS)
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const response =
      parsed && typeof parsed === 'object' && 'response' in parsed ? parsed.response : undefined
    if (
      response &&
      typeof response === 'object' &&
      'subtype' in response &&
      response.subtype === 'success' &&
      'request_id' in response &&
      response.request_id === REQUEST_ID &&
      'response' in response
    ) {
      return new ClaudeSlashCommandCatalog(undefined, response.response).commands
    }
  }
  return undefined
}
