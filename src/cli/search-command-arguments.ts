import { homedir } from 'node:os'
import { join } from 'node:path'
import { AI_VAULT_AGENTS, type AiVaultAgent } from '../shared/ai-vault-types'
import {
  SessionSearchConfigureSchema,
  SessionSearchQuerySchema,
  type SessionSearchConfigure
} from '../shared/ai-vault-search-contract'
import type { AiVaultSearchArgs } from '../shared/ai-vault-search-types'
import { isRuntimePathAbsolute } from '../shared/cross-platform-path'
import { parseHostFlag } from './execution-host-flag'
import { SEARCH_BOOLEAN_FLAGS } from './specs/search'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRepeatedStringFlag
} from './flags'
import { RuntimeClientError } from './runtime/types'

export type SearchCommand = {
  query?: AiVaultSearchArgs
  configure?: SessionSearchConfigure
  status: boolean
  host: ReturnType<typeof parseHostFlag> | 'all'
}

function invalid(message: string): never {
  throw new RuntimeClientError('invalid_argument', message)
}

export function parseSearchCommand(
  flags: Map<string, string | boolean>,
  remote = false
): SearchCommand {
  const host = flags.get('host') === 'all' ? 'all' : parseHostFlag(flags)
  const configure: SessionSearchConfigure = {}
  for (const flag of SEARCH_BOOLEAN_FLAGS) {
    if (flags.has(flag) && flags.get(flag) !== true) {
      invalid(`--${flag} does not take a value.`)
    }
  }
  if (flags.get('enable') && flags.get('disable')) {
    invalid('Use either --enable or --disable.')
  }
  if (flags.get('pause') && flags.get('resume-indexing')) {
    invalid('Use either --pause or --resume-indexing.')
  }
  if (flags.get('enable')) {
    configure.enabled = true
  }
  if (flags.get('disable')) {
    configure.enabled = false
  }
  if (flags.get('pause')) {
    configure.paused = true
  }
  if (flags.get('resume-indexing')) {
    configure.paused = false
  }
  if (flags.get('clear-index')) {
    configure.clearIndex = true
  }
  const history = getOptionalStringFlag(flags, 'history-days')
  if (history !== undefined) {
    configure.historyDays = history === 'all' ? null : Number(history)
  }
  const config = SessionSearchConfigureSchema.safeParse(configure)
  if (!config.success) {
    invalid('Invalid search policy: history-days must be 1..3650 or all.')
  }
  const mutation = Object.keys(configure).length > 0
  const status = flags.get('index-status') === true
  if (host === 'all' && (mutation || status)) {
    invalid('Select one host to manage its search index.')
  }
  const raw = flags.get('agent-session')
  const query = raw === true && mutation ? undefined : getOptionalStringFlag(flags, 'agent-session')
  if (status && (mutation || query)) {
    invalid('Use --index-status without a query or policy change.')
  }
  if (!query && !mutation && !status) {
    invalid('Missing --agent-session <query>.')
  }
  if (!query && ['agent', 'path', 'since', 'limit', 'newest'].some((flag) => flags.has(flag))) {
    invalid(
      'Search filters require --agent-session <query>; they do not restrict which sources are indexed.'
    )
  }
  const agents = getRepeatedStringFlag(flags, 'agent').map((value) => {
    const agent = value.toLowerCase() as AiVaultAgent
    if (!AI_VAULT_AGENTS.includes(agent)) {
      invalid(`Unknown --agent ${value}.`)
    }
    return agent
  })
  const paths = getRepeatedStringFlag(flags, 'path').map((path) => {
    if (
      path.startsWith('~') &&
      (remote || host === 'all' || host?.kind === 'ssh' || host?.kind === 'runtime')
    ) {
      invalid('Use an absolute path on the execution host instead of ~.')
    }
    const expanded =
      path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
    if ((host === 'all' || host?.kind === 'ssh') && !isRuntimePathAbsolute(expanded)) {
      invalid('--path must be absolute on the execution host.')
    }
    return expanded
  })
  const since = getOptionalStringFlag(flags, 'since')
  if (
    since &&
    (!/^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/.test(since) || !Number.isFinite(Date.parse(since)))
  ) {
    invalid('--since must be an ISO 8601 timestamp.')
  }
  const args = {
    query: query ?? 'policy validation',
    limit: getOptionalPositiveIntegerFlag(flags, 'limit'),
    agents: agents.length ? [...new Set(agents)] : undefined,
    scopePaths: paths.length ? paths : undefined,
    since: since ? new Date(since).toISOString() : undefined,
    sort: flags.get('newest') === true ? 'newest' : 'relevance'
  }
  const validated = SessionSearchQuerySchema.safeParse(args)
  if (!validated.success) {
    invalid(validated.error.issues[0]?.message ?? 'Invalid search query.')
  }
  return {
    host,
    status,
    configure: mutation ? configure : undefined,
    query: query ? validated.data : undefined
  }
}
