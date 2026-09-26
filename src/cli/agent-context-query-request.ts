import { parsePositiveSafeIntegerText } from '../shared/timer-delay'
import { RuntimeClientError } from './runtime/types'

export const DEFAULT_AGENT_CONTEXT_SEARCH_LIMIT = 20
export const MAX_AGENT_CONTEXT_SEARCH_LIMIT = 50
export const MAX_AGENT_CONTEXT_QUERY_LENGTH = 256

export type AgentContextDetail = 'summary' | 'full'

export type AgentContextQuery =
  | { view: 'command'; value: string; detail: 'full' }
  | { view: 'prefix'; value: string; detail: AgentContextDetail }
  | { view: 'roots' }
  | { view: 'search'; value: string; detail: AgentContextDetail; limit: number }

export type AgentContextRequest = {
  query: AgentContextQuery | null
  compact: boolean
}

const SELECTOR_FLAGS = ['roots', 'command', 'prefix', 'search'] as const

export function parseAgentContextRequest(
  flags: Map<string, string | boolean>,
  json: boolean
): AgentContextRequest {
  requireBooleanFlag(flags, 'roots')
  requireBooleanFlag(flags, 'full')
  requireBooleanFlag(flags, 'compact')
  const compact = flags.has('compact')
  if (compact && !json) {
    throw new RuntimeClientError('invalid_argument', '--compact requires --json.')
  }

  const selectors = SELECTOR_FLAGS.filter((flag) => flags.has(flag))
  if (selectors.length > 1) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Pass only one agent-context selector: ${SELECTOR_FLAGS.map((flag) => `--${flag}`).join(', ')}.`
    )
  }

  const selector = selectors[0]
  if (!selector) {
    rejectFlag(flags, 'limit', 'requires --search')
    rejectFlag(flags, 'full', 'requires --prefix or --search')
    return { query: null, compact }
  }
  if (selector !== 'search') {
    rejectFlag(flags, 'limit', 'requires --search')
  }
  if (selector !== 'prefix' && selector !== 'search') {
    rejectFlag(flags, 'full', 'requires --prefix or --search')
  }
  if (selector === 'roots') {
    return { query: { view: 'roots' }, compact }
  }

  const value = requireQueryValue(flags, selector)
  const detail = flags.has('full') ? 'full' : 'summary'
  if (selector === 'command') {
    return { query: { view: 'command', value, detail: 'full' }, compact }
  }
  if (selector === 'prefix') {
    return { query: { view: 'prefix', value, detail }, compact }
  }
  return {
    query: {
      view: 'search',
      value,
      detail,
      limit: parseSearchLimit(flags)
    },
    compact
  }
}

export function normalizeAgentContextQueryText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}

function requireQueryValue(
  flags: Map<string, string | boolean>,
  flag: 'command' | 'prefix' | 'search'
): string {
  const value = flags.get(flag)
  if (typeof value !== 'string') {
    throw new RuntimeClientError('invalid_argument', `Flag --${flag} requires a value.`)
  }
  const normalized = normalizeAgentContextQueryText(value)
  if (normalized.length === 0) {
    throw new RuntimeClientError('invalid_argument', `Flag --${flag} requires a value.`)
  }
  if (normalized.length > MAX_AGENT_CONTEXT_QUERY_LENGTH) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--${flag} must be at most ${MAX_AGENT_CONTEXT_QUERY_LENGTH} characters.`
    )
  }
  return normalized
}

function parseSearchLimit(flags: Map<string, string | boolean>): number {
  if (!flags.has('limit')) {
    return DEFAULT_AGENT_CONTEXT_SEARCH_LIMIT
  }
  const raw = flags.get('limit')
  if (typeof raw !== 'string') {
    throw new RuntimeClientError('invalid_argument', 'Flag --limit requires a value.')
  }
  const limit = parsePositiveSafeIntegerText(raw)
  if (limit === null || limit > MAX_AGENT_CONTEXT_SEARCH_LIMIT) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--limit must be an integer from 1 to ${MAX_AGENT_CONTEXT_SEARCH_LIMIT}.`
    )
  }
  return limit
}

function requireBooleanFlag(
  flags: Map<string, string | boolean>,
  flag: 'compact' | 'full' | 'roots'
): void {
  if (flags.has(flag) && flags.get(flag) !== true) {
    throw new RuntimeClientError('invalid_argument', `--${flag} does not take a value.`)
  }
}

function rejectFlag(
  flags: Map<string, string | boolean>,
  flag: 'full' | 'limit',
  requirement: string
): void {
  if (flags.has(flag)) {
    throw new RuntimeClientError('invalid_argument', `--${flag} ${requirement}.`)
  }
}
