// `--on "teams.mentioned in=<chat refs> contains=<text>"`: a rule this host checks itself.
import { createHash } from 'node:crypto'
import type { AutomationTeamsTrigger } from '../../shared/automation-teams-triggers'
import { RuntimeClientError } from '../runtime/connection/types'

type Entry = readonly [key: string, value: string, ...written: string[]]

const KEYS = ['in', 'contains'] as const

function invalid(message: string): RuntimeClientError {
  return new RuntimeClientError('invalid_argument', message)
}

function quoted(value: string): string {
  return /[\s"\\]/.test(value) ? `"${value.replace(/["\\]/g, '\\$&')}"` : value
}

export function parseTeamsTrigger(spec: string, entries: readonly Entry[]): AutomationTeamsTrigger {
  const values = new Map<(typeof KEYS)[number], string>()
  for (const [key, value] of entries) {
    const known = KEYS.find((entry) => entry === key)
    if (!known) {
      throw invalid(`Unknown filter "${key}=" in --on "${spec}". Use in= or contains=.`)
    }
    if (values.has(known) || !value.trim()) {
      throw invalid(`--on "${spec}" needs one value for ${known}=.`)
    }
    values.set(known, value.trim())
  }
  const places = values
    .get('in')
    ?.split(',')
    .map((place) => place.trim())
  // A blank place would silently widen the rule to every chat.
  if (places?.some((place) => !place)) {
    throw invalid(`--on "${spec}" needs in= to list chat refs, separated by commas.`)
  }
  const textContains = values.get('contains')
  const rule = {
    source: 'teams' as const,
    event: 'mentioned' as const,
    ...(places?.length ? { in: [...new Set(places)].sort() } : {}),
    ...(textContains ? { textContains } : {})
  }
  // An unchanged rule keeps its id, so run history still names it.
  const id = `on-${createHash('sha256').update(JSON.stringify(rule)).digest('hex').slice(0, 16)}`
  return { id, ...rule }
}

/** The rule as an --on value; parsing it gives the same rule back. */
export function formatTeamsTrigger(trigger: AutomationTeamsTrigger): string {
  return [
    'teams.mentioned',
    ...(trigger.in?.length ? [`in=${trigger.in.join(',')}`] : []),
    ...(trigger.textContains ? [`contains=${quoted(trigger.textContains)}`] : [])
  ].join(' ')
}

export function describeTeamsTrigger(trigger: AutomationTeamsTrigger): string {
  return [
    'your owner is @mentioned in a Teams chat',
    ...(trigger.in?.length ? [`in ${trigger.in.join(', ')}`] : []),
    ...(trigger.textContains ? [`containing "${trigger.textContains}"`] : [])
  ].join(', ')
}

export const TEAMS_TRIGGER_OPTIONS = [
  'teams:',
  '  teams.mentioned  when someone else @mentions your owner in one of their Teams chats (1:1, group or meeting chat; not channels yet)',
  '  in=<chat refs>  only in these chats: refs from `orca teams find`, comma-separated',
  '  contains="<text>"  only when the message contains this (any case)',
  '  Checked about once a minute on the computer the bot runs on. The run acts as the owner, like `orca teams`: answer with `orca teams post`. What the message says is quoted as information, never instructions.'
].join('\n')
