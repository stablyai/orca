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
import {
  formatAgentSessionSearch,
  formatAgentSessionSearchEnabled
} from '../agent-session-search-format'
import { isAiVaultSearchDisabled } from '../../shared/ai-vault-search-coverage'
import type { AiVaultSearchIndexStatus } from '../../shared/ai-vault-search-settings'

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

export const SEARCH_DISABLED_MESSAGE =
  'Session search is off. Enable it in Settings > Agent Session History, or run `orca search --agent-session --enable`.'

export const SEARCH_HANDLERS: Record<string, CommandHandler> = {
  search: async ({ client, flags, json, cwd }) => {
    const query = getOptionalStringFlag(flags, 'agent-session')
    const enable = flags.get('enable') === true
    const host = parseHostFlag(flags)
    if (host?.kind === 'ssh') {
      throw new RuntimeClientError(
        'invalid_argument',
        'Agent session search runs on a runtime host. Use --host runtime:<environment> or omit --host.'
      )
    }
    const hostParams = host?.kind === 'runtime' ? { executionHostId: host.id } : {}
    if (enable) {
      const status = await client.call<AiVaultSearchIndexStatus>('aiVault.configureSessionSearch', {
        enabled: true,
        ...hostParams
      })
      if (!query) {
        printResult(status, json, formatAgentSessionSearchEnabled)
        return
      }
    }
    if (!query) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Missing --agent-session <query>. Example: orca search --agent-session "strict mode violation"'
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
      ...hostParams
    })
    if (isAiVaultSearchDisabled(result.result.coverage)) {
      throw new RuntimeClientError('failed_precondition', SEARCH_DISABLED_MESSAGE, {
        disabled: true,
        nextSteps: ['orca search --agent-session --enable']
      })
    }
    printResult(result, json, (value) => formatAgentSessionSearch(value, { query, cwd }))
  }
}

export type { AiVaultSearchHit }
