import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRepeatedStringFlag
} from '../flags'
import { parseHostFlag } from '../execution-host-flag'
import { RuntimeClientError } from '../runtime/types'
import { AI_VAULT_AGENTS, type AiVaultAgent } from '../../shared/ai-vault-types'
import type { AiVaultSearchHit, AiVaultSearchResult } from '../../shared/ai-vault-search-types'
import { formatAgentSessionSearch } from '../agent-session-search-format'

function parseAgents(flags: Map<string, string | boolean>): AiVaultAgent[] | undefined {
  const values = getRepeatedStringFlag(flags, 'agent')
  if (values.length === 0) {
    return undefined
  }
  const agents: AiVaultAgent[] = []
  for (const value of values) {
    const lowered = value.toLowerCase()
    if (!(AI_VAULT_AGENTS as readonly string[]).includes(lowered)) {
      throw new RuntimeClientError(
        'invalid_argument',
        `Unknown --agent ${value}. Expected one of: ${AI_VAULT_AGENTS.join(', ')}.`
      )
    }
    agents.push(lowered as AiVaultAgent)
  }
  return agents
}

function parseSince(flags: Map<string, string | boolean>): string | undefined {
  const value = getOptionalStringFlag(flags, 'since')
  if (value === undefined) {
    return undefined
  }
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) {
    throw new RuntimeClientError('invalid_argument', '--since must be an ISO 8601 timestamp.')
  }
  return new Date(parsed).toISOString()
}

export const SEARCH_HANDLERS: Record<string, CommandHandler> = {
  search: async ({ client, flags, json, cwd }) => {
    const query = getOptionalStringFlag(flags, 'agent-session')
    if (!query) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Missing --agent-session <query>. Example: orca search --agent-session "strict mode violation"'
      )
    }
    const host = parseHostFlag(flags)
    if (host?.kind === 'ssh') {
      throw new RuntimeClientError(
        'invalid_argument',
        'Agent session search runs on a runtime host. Use --host runtime:<environment> or omit --host.'
      )
    }
    const scopePaths = getRepeatedStringFlag(flags, 'path').map((value) =>
      value.startsWith('~') ? value.replace(/^~/, process.env.HOME ?? '~') : value
    )
    const result = await client.call<AiVaultSearchResult>('aiVault.searchSessions', {
      query,
      limit: getOptionalPositiveIntegerFlag(flags, 'limit'),
      agents: parseAgents(flags),
      scopePaths: scopePaths.length > 0 ? scopePaths : undefined,
      since: parseSince(flags),
      sort: flags.get('newest') === true ? 'newest' : 'relevance',
      ...(host?.kind === 'runtime' ? { executionHostId: host.id } : {})
    })
    printResult(result, json, (value) => formatAgentSessionSearch(value, { query, cwd }))
  }
}

export type { AiVaultSearchHit }
