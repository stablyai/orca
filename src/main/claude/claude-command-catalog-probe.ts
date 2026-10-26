import type { AgentSessionSlashCommand } from '../../shared/agent-session-wire'
import { assertJsonTextStructureWithinLimits } from '../../shared/json-text-structure-limit'
import { runClaudeListing, type ClaudeModelCatalogProbeDeps } from './claude-model-catalog-probe'
import { ClaudeSlashCommandCatalog } from './claude-slash-command-catalog'

const REQUEST_ID = 'orca-command-discovery'

// initialize lists the live chat command surface without spending an API turn.
const CLAUDE_COMMAND_LIST_STDIN = `${JSON.stringify({
  type: 'control_request',
  request_id: REQUEST_ID,
  request: { subtype: 'initialize' }
})}\n`

const INITIALIZE_JSON_LIMITS = { structuralTokens: 64 * 1024, nestingDepth: 16 } as const

export type ClaudeCommandCatalogProbe = (request: {
  cwd: string
  accountHomePath: string
  isCurrent?: () => boolean
}) => Promise<AgentSessionSlashCommand[]>

export function createClaudeCommandCatalogProbe(
  deps: ClaudeModelCatalogProbeDeps
): ClaudeCommandCatalogProbe {
  return async ({ cwd, accountHomePath, isCurrent }) => {
    const stdout = await runClaudeListing(deps, {
      accountHomePath,
      cwd,
      stdin: CLAUDE_COMMAND_LIST_STDIN,
      site: 'claude-command-catalog-probe',
      isCurrent
    })
    const commands = readInitializeCommands(stdout)
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
