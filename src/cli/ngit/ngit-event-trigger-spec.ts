// `--on "ngit.issue_opened in=nostr://… from=… contains=… subject=…"`: rules this host checks itself.
import { createHash } from 'node:crypto'
import {
  NGIT_ANYONE,
  NGIT_EVENT_KINDS,
  type AutomationNgitTrigger
} from '../../shared/automation-ngit-triggers'
import { EVENT_WORDS } from '../automations/automation-event-words'
import { RuntimeClientError } from '../runtime/connection/types'

type Entry = readonly [key: string, value: string, ...written: string[]]

const NGIT_KEYS = ['in', 'from', 'contains', 'subject'] as const
type NgitKey = (typeof NGIT_KEYS)[number]

export const NGIT_TRIGGER_OPTIONS = [
  'ngit:',
  ...NGIT_EVENT_KINDS.map((event) => `  ngit.${event}  when ${EVENT_WORDS.ngit[event]}`),
  '  in=<urls>  required: the nostr:// repositories to watch, comma-separated (`git remote -v` shows it)',
  '  from=<people>  npubs, or anyone; without it only the repository maintainers start it',
  '  contains="<text>"  only when the title or text contains this (any case)',
  '  subject=<id>  only this issue or pull request, by 8 or more characters of its event id',
  "  This host reads the repository's relays about every 3 minutes. Events your owner signs with ngit here start a rule only when from= names them."
].join('\n')

function invalid(message: string): RuntimeClientError {
  return new RuntimeClientError('invalid_argument', message)
}

function listOf(raw: string | undefined): string[] | undefined {
  const list = raw
    ?.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  return list?.length ? [...new Set(list)].sort() : undefined
}

export function parseNgitTrigger(
  spec: string,
  head: string,
  entries: readonly Entry[]
): AutomationNgitTrigger {
  const event = NGIT_EVENT_KINDS.find((kind) => `ngit.${kind}` === head)
  if (!event) {
    throw invalid(
      `Unknown event "${head}". Run \`orca automations trigger-options --source ngit\`.`
    )
  }
  const values = new Map<NgitKey, string>()
  for (const [key, value] of entries) {
    const known = NGIT_KEYS.find((entry) => entry === key)
    if (!known) {
      throw invalid(
        `Unknown filter "${key}=" in --on "${spec}". Use ${NGIT_KEYS.map((entry) => `${entry}=`).join(', ')}.`
      )
    }
    if (values.has(known) || !value.trim()) {
      throw invalid(`--on "${spec}" needs one value for ${known}=.`)
    }
    values.set(known, value.trim())
  }
  const repositories = listOf(values.get('in'))
  if (!repositories?.every((url) => url.startsWith('nostr://'))) {
    throw invalid(`--on "${spec}" needs in= to name a nostr:// repository.`)
  }
  const from = listOf(values.get('from'))
  if (from?.some((person) => person !== NGIT_ANYONE && !person.startsWith('npub1'))) {
    throw invalid(`--on "${spec}": from= takes npubs or ${NGIT_ANYONE}.`)
  }
  const contains = values.get('contains')
  const subject = values.get('subject')?.toLowerCase()
  const rule = {
    source: 'ngit' as const,
    event,
    in: repositories,
    ...(from ? { from } : {}),
    ...(contains ? { textContains: contains } : {}),
    ...(subject ? { subject } : {})
  }
  // An unchanged rule keeps its id, so run history still names it.
  const digest = createHash('sha256').update(JSON.stringify(rule)).digest('hex')
  return { id: `on-${digest.slice(0, 16)}`, ...rule }
}

export function formatNgitTrigger(
  trigger: AutomationNgitTrigger,
  quote: (value: string) => string
): string {
  return [
    `ngit.${trigger.event}`,
    `in=${trigger.in.join(',')}`,
    ...(trigger.textContains ? [`contains=${quote(trigger.textContains)}`] : []),
    ...(trigger.subject ? [`subject=${trigger.subject}`] : []),
    ...(trigger.from?.length ? [`from=${trigger.from.join(',')}`] : [])
  ].join(' ')
}

export function describeNgitTrigger(trigger: AutomationNgitTrigger): string {
  return [
    EVENT_WORDS.ngit[trigger.event],
    `in ${trigger.in.join(', ')}`,
    ...(trigger.subject ? [`on ${trigger.subject}`] : []),
    ...(trigger.textContains ? [`containing "${trigger.textContains}"`] : []),
    trigger.from?.length ? `from ${trigger.from.join(', ')}` : 'from its maintainers'
  ].join(', ')
}
