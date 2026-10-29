import {
  AI_VAULT_AGENTS,
  AI_VAULT_SCOPE_PATHS_MAX_COUNT,
  type AiVaultAgent
} from '../shared/ai-vault-types'
import { AiVaultSearchFiltersSchema } from '../shared/ai-vault-search-contract'
import type { AiVaultSearchRequest } from '../shared/ai-vault-search-types'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRepeatedStringFlag
} from './flags'
import { RuntimeClientError } from './runtime/types'

export type SearchCommand =
  | { kind: 'index-status' }
  | { kind: 'search'; request: AiVaultSearchRequest }

// --index-status uses a different RPC; query flags would otherwise be silently ignored.
const QUERY_ONLY_FLAGS = [
  'query',
  'scope',
  'fresh',
  'limit',
  'cursor',
  'agent',
  'path',
  'since',
  'sort',
  'debug'
] as const

function readEnum<TValue extends string>(
  flags: Map<string, string | boolean>,
  name: string,
  allowed: readonly TValue[]
): TValue | undefined {
  const value = getOptionalStringFlag(flags, name)
  if (value === undefined) {
    return undefined
  }
  const matched = allowed.find((candidate) => candidate === value)
  if (matched === undefined) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Unsupported --${name} "${value}". Use ${allowed.join(' or ')}.`
    )
  }
  return matched
}

const KNOWN_AGENTS = new Set<string>(AI_VAULT_AGENTS)

function isAiVaultAgent(value: string): value is AiVaultAgent {
  return KNOWN_AGENTS.has(value)
}

function readAgents(flags: Map<string, string | boolean>): AiVaultAgent[] | undefined {
  const agents = getRepeatedStringFlag(flags, 'agent')
  if (agents.length === 0) {
    return undefined
  }
  const unknown = agents.filter((agent) => !isAiVaultAgent(agent))
  if (unknown.length > 0) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Unknown --agent ${unknown.map((agent) => `"${agent}"`).join(', ')}. Known agents: ${AI_VAULT_AGENTS.join(', ')}.`
    )
  }
  return agents.filter(isAiVaultAgent)
}

function readScopePaths(flags: Map<string, string | boolean>): string[] | undefined {
  const paths = getRepeatedStringFlag(flags, 'path')
  if (paths.length === 0) {
    return undefined
  }
  if (paths.length > AI_VAULT_SCOPE_PATHS_MAX_COUNT) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Too many --path values (${paths.length}); at most ${AI_VAULT_SCOPE_PATHS_MAX_COUNT} are accepted.`
    )
  }
  return paths
}

// Reuse the host schema so timestamp offset requirements cannot drift.
function readSince(flags: Map<string, string | boolean>): string | undefined {
  const since = getOptionalStringFlag(flags, 'since')
  if (since === undefined) {
    return undefined
  }
  if (!AiVaultSearchFiltersSchema.shape.since.safeParse(since).success) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Invalid --since "${since}". Use an ISO 8601 timestamp with an offset, for example 2026-08-01T00:00:00Z.`
    )
  }
  return since
}

function readQuery(flags: Map<string, string | boolean>): string {
  const query = getOptionalStringFlag(flags, 'query')
  if (query === undefined) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Missing a search query. Pass it as `orca search "<query>"` or --query "<query>", or ask for the index report with --index-status.'
    )
  }
  return query
}

function readFilters(
  flags: Map<string, string | boolean>
): AiVaultSearchRequest['filters'] | undefined {
  const agents = readAgents(flags)
  const scopePaths = readScopePaths(flags)
  const since = readSince(flags)
  const sort = readEnum(flags, 'sort', ['relevance', 'newest'] as const)
  const filters = {
    ...(agents ? { agents } : {}),
    ...(scopePaths ? { scopePaths } : {}),
    ...(since ? { since } : {}),
    ...(sort ? { sort } : {})
  }
  return Object.keys(filters).length > 0 ? filters : undefined
}

export function parseSearchCommand(flags: Map<string, string | boolean>): SearchCommand {
  if (flags.has('index-status')) {
    const conflicting = QUERY_ONLY_FLAGS.filter((flag) => flags.has(flag))
    if (conflicting.length > 0) {
      throw new RuntimeClientError(
        'invalid_argument',
        `--index-status reports on the index and takes no query, so it cannot be combined with ${conflicting.map((flag) => `--${flag}`).join(', ')}.`
      )
    }
    return { kind: 'index-status' }
  }

  const query = readQuery(flags)
  const scope = readEnum(flags, 'scope', ['conversation', 'all'] as const)
  const limit = getOptionalPositiveIntegerFlag(flags, 'limit')
  const cursor = getOptionalStringFlag(flags, 'cursor')
  const filters = readFilters(flags)
  return {
    kind: 'search',
    request: {
      query,
      ...(scope ? { scope } : {}),
      ...(flags.has('fresh') ? { freshness: 'wait-until-current' as const } : {}),
      ...(limit === undefined ? {} : { limit }),
      ...(cursor ? { cursor } : {}),
      ...(filters ? { filters } : {}),
      ...(flags.has('debug') ? { debug: true } : {})
    }
  }
}
