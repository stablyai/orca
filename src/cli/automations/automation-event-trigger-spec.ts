// `--on "<source>.<event> in=... contains=... subject=..."`: one event trigger, written by a bot or a person.
import { createHash } from 'node:crypto'
import { GITHUB2_EVENT_KINDS } from '../../shared/automation-github-triggers'
import {
  AUTOMATION_EVENT_KINDS,
  isWebhookTrigger,
  type AutomationConnectorEventTrigger,
  type AutomationEventSource,
  type AutomationEventTrigger
} from '../../shared/automation-event-triggers'
import { botEventSources, type BotConnectors } from '../../shared/bot-event-sources'
import { CONNECTOR_SOURCE_NAMES } from '../../shared/connectors/external-conversation-link'
import { legacyPlaceOf, legacySubjectOf } from '../../shared/connector-place-names'
import { RuntimeClientError } from '../runtime/connection/types'
import * as own from './automation-own-trigger-spec'
import { offeredEvents } from './automation-offered-events'

export { offeredEvents }
import { parseRunFilter, RUN_TRIGGER_OPTION } from './automation-workflow-run-spec'
import {
  EVENT_WORDS,
  PLACE_WORDS,
  SOURCE_NOTES,
  SUBJECT_WORDS,
  WORKFLOW_WAIT_RECIPE
} from './automation-event-words'
import {
  describeWebhookTrigger,
  formatWebhookTrigger,
  parseWebhookTrigger,
  WEBHOOK_TRIGGER_OPTIONS
} from '../webhooks/webhook-trigger-spec'
import {
  describeGoogleTrigger,
  formatGoogleTrigger,
  GOOGLE_TRIGGER_OPTIONS,
  parseGoogleTrigger
} from '../google/google-event-trigger-spec'
import { GOOGLE_EVENT_SOURCES, isGoogleTrigger } from '../../shared/automation-google-triggers'

type ConnectorEventSource = AutomationConnectorEventTrigger['source']

const FILTER_KEYS = ['in', 'contains', 'subject', 'from', 'on', 'label', 'run'] as const
type FilterKey = (typeof FILTER_KEYS)[number]

// A word, or key="quoted value" where \" and \\ stand for themselves.
const TOKEN = /([a-z-]+)="((?:[^"\\]|\\.)*)"|(\S+)/g

function invalid(message: string): RuntimeClientError {
  return new RuntimeClientError('invalid_argument', message)
}

const CONNECTOR_SOURCES: readonly ConnectorEventSource[] = ['slack', 'github', 'linear']
// Offered only for a bot whose host's Orca Cloud takes webhooks.
const ALL_SOURCES: readonly AutomationEventSource[] = [
  ...CONNECTOR_SOURCES,
  ...GOOGLE_EVENT_SOURCES,
  'webhook'
]

const EVENTS: Pick<AutomationConnectorEventTrigger, 'source' | 'event'>[] = [
  ...AUTOMATION_EVENT_KINDS.slack.map((event) => ({ source: 'slack' as const, event })),
  ...AUTOMATION_EVENT_KINDS.github.map((event) => ({ source: 'github' as const, event })),
  ...AUTOMATION_EVENT_KINDS.linear.map((event) => ({ source: 'linear' as const, event }))
]

function isKnownSource(raw: string): raw is AutomationEventSource {
  return ALL_SOURCES.some((source) => source === raw)
}

function eventOf(head: string): Pick<AutomationConnectorEventTrigger, 'source' | 'event'> {
  const known = EVENTS.find(({ source, event }) => `${source}.${event}` === head)
  if (!known) {
    throw invalid(
      `Unknown event "${head}". Run \`orca automations trigger-options\` for the events each source has.`
    )
  }
  return known
}

/** Each `key=value` after the event, in order, with how it was written. */
function entriesOf(
  spec: string,
  tokens: RegExpMatchArray[]
): [key: string, value: string, written: string][] {
  return tokens.map(([, quotedKey, quoted, word]) => {
    if (quotedKey !== undefined) {
      return [quotedKey, quoted.replace(/\\(.)/g, '$1'), quotedKey]
    }
    if (!word.includes('=')) {
      throw invalid(`Unknown filter "${word}" in --on "${spec}". Filters are written key=value.`)
    }
    return [word.slice(0, word.indexOf('=')), word.slice(word.indexOf('=') + 1), word]
  })
}

function filtersOf(spec: string, tokens: RegExpMatchArray[]): Map<FilterKey, string> {
  const filters = new Map<FilterKey, string>()
  for (const [key, value, written] of entriesOf(spec, tokens)) {
    const known = FILTER_KEYS.find((entry) => entry === key)
    if (!known) {
      throw invalid(
        `Unknown filter "${written}" in --on "${spec}". Use in=, contains=, subject=, from=, on=mine, label= or run=.`
      )
    }
    if (filters.has(known) || !value) {
      throw invalid(`--on "${spec}" needs one value for ${known}=.`)
    }
    filters.set(known, value)
  }
  return filters
}

function quoteValue(value: string): string {
  return /[\s"\\]/.test(value) ? `"${value.replace(/["\\]/g, '\\$&')}"` : value
}

/** The trigger as an --on value; parsing it gives the same trigger back. */
export function formatAutomationEventTrigger(trigger: AutomationEventTrigger): string {
  if (isWebhookTrigger(trigger)) {
    return formatWebhookTrigger(trigger)
  }
  if (isGoogleTrigger(trigger)) {
    return formatGoogleTrigger(trigger)
  }
  return [
    `${trigger.source}.${trigger.event}`,
    ...(trigger.in?.length ? [`in=${trigger.in.join(',')}`] : []),
    ...(trigger.textContains ? [`contains=${quoteValue(trigger.textContains)}`] : []),
    ...(trigger.label ? [`label=${quoteValue(trigger.label)}`] : []),
    ...(trigger.run ? [`run=${trigger.run}`] : []),
    ...(trigger.subject ? [`subject=${quoteValue(trigger.subject)}`] : []),
    ...(own.peopleOf(trigger).length ? [`from=${own.peopleOf(trigger).join(',')}`] : []),
    ...(trigger.onOwnerMessage ? ['on=mine'] : [])
  ].join(' ')
}

export function parseAutomationEventTrigger(spec: string): AutomationEventTrigger {
  const [head, ...rest] = [...spec.matchAll(TOKEN)]
  if (!head || head[3] === undefined) {
    throw invalid(`--on needs an event such as slack.mentioned, not "${spec}".`)
  }
  if (head[3] === 'webhook.call') {
    return parseWebhookTrigger(spec, entriesOf(spec, rest))
  }
  if (head[3] === 'gmail.new_email' || head[3] === 'calendar.starting_soon') {
    return parseGoogleTrigger(spec, head[3], entriesOf(spec, rest))
  }
  const filters = filtersOf(spec, rest)
  const sourceEvent = eventOf(head[3])
  const onSubject = filters.get('subject')?.trim()
  // An id or key in its one spelling, so one rule has one id; the host looks the rest up as refs.
  const ids = filters
    .get('in')
    ?.split(',')
    .map((place) => legacyPlaceOf(sourceEvent.source, place) ?? place.trim())
  // A blank place would silently widen the rule to everywhere.
  if (ids?.some((place) => !place)) {
    throw invalid(`--on "${spec}" needs in= to list places, separated by commas.`)
  }
  const { others, fromOwner } = own.parseFromPeople(spec, sourceEvent, filters.get('from'))
  const onMine = filters.get('on')
  if (onMine !== undefined && (onMine !== 'mine' || head[3] !== 'slack.reaction')) {
    throw invalid(
      `--on "${spec}": on=mine is for slack.reaction only, for reactions on your own messages.`
    )
  }
  const label = filters.get('label')?.trim()
  if (label !== undefined && head[3] !== 'github.labeled') {
    throw invalid(`--on "${spec}": label= is for github.labeled only.`)
  }
  // A blank label would silently widen the rule to every label.
  if (label === '') {
    throw invalid(`--on "${spec}" needs label= to name a label.`)
  }
  const waited = parseRunFilter(spec, head[3], filters.get('run'), ids)
  // Assigned onto the event, so the trigger stays one source's shape.
  const trigger: AutomationConnectorEventTrigger = Object.assign(
    { id: '' },
    sourceEvent,
    (waited.in ?? ids)?.length ? { in: [...new Set(waited.in ?? ids)].sort() } : {},
    filters.has('contains') ? { textContains: filters.get('contains') } : {},
    label ? { label } : {},
    waited.run ? { run: waited.run } : {},
    onSubject ? { subject: legacySubjectOf(sourceEvent.source, onSubject) ?? onSubject } : {},
    others?.length ? { from: [...new Set(others)].sort() } : {},
    onMine ? { onOwnerMessage: true as const } : {},
    fromOwner ? { fromOwner: true as const } : {}
  )
  // The same rule keeps its id, so run history and the cloud's copy still name it after an edit; the
  // later filters join it only when set, so rules without them keep theirs.
  const {
    source,
    event,
    in: where,
    textContains,
    subject,
    from,
    onOwnerMessage,
    label: named,
    run
  } = trigger
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        source,
        event,
        where ?? [],
        textContains ?? '',
        subject ?? '',
        ...(from || onOwnerMessage ? [from ?? [], onOwnerMessage === true] : []),
        ...own.ownIdParts(trigger),
        ...(named ? [`label:${named.toLowerCase()}`] : []),
        ...(run ? [`run:${run}`] : [])
      ])
    )
    .digest('hex')
  trigger.id = `on-${digest.slice(0, 16)}`
  return trigger
}

/** What starts it, in words: "your owner is mentioned in a channel the bot is in, in C0123, containing "deploy"". */
export function describeAutomationEventTrigger(trigger: AutomationEventTrigger): string {
  if (isWebhookTrigger(trigger)) {
    return describeWebhookTrigger(trigger)
  }
  if (isGoogleTrigger(trigger)) {
    return describeGoogleTrigger(trigger)
  }
  const words: Record<string, string> = EVENT_WORDS[trigger.source]
  return [
    words[trigger.event] ?? `${trigger.source}.${trigger.event}`,
    ...(trigger.in?.length ? [`in ${trigger.in.join(', ')}`] : []),
    ...(trigger.subject ? [`on ${trigger.subject}`] : []),
    ...(trigger.textContains ? [`containing "${trigger.textContains}"`] : []),
    ...(trigger.label ? [`labeled "${trigger.label}"`] : []),
    ...(trigger.run ? [`run ${trigger.run}`] : []),
    ...(own.peopleOf(trigger).length ? [`from ${own.peopleOf(trigger, 'you').join(', ')}`] : []),
    ...(trigger.onOwnerMessage ? ['on your own messages'] : [])
  ].join(', ')
}

export function offeredEventSources(
  only?: AutomationEventSource,
  bot?: BotConnectors
): readonly AutomationEventSource[] {
  const offered = ALL_SOURCES.filter((source) => source !== 'webhook' || bot?.webhooks === true)
  return only ? offered.filter((source) => source === only) : offered
}

/** Each source's events and filters, for `orca automations trigger-options`; with a bot, only its connectors' in full. */
export function formatAutomationTriggerOptions(
  only?: AutomationEventSource,
  bot?: BotConnectors
): string {
  const heard = bot ? botEventSources(bot) : undefined
  const sources = offeredEventSources(only, bot).map((source) => {
    if (source === 'webhook') {
      return WEBHOOK_TRIGGER_OPTIONS
    }
    if (isGoogleTrigger({ source })) {
      return bot && !heard?.includes(source)
        ? `${source}: none of these start ${bot.name}: Google is off for it. Its owner can turn it on with \`orca google bot "${bot.name}" --on\`.`
        : GOOGLE_TRIGGER_OPTIONS[source]
    }
    const words: Record<string, string> = EVENT_WORDS[source]
    if (bot && !heard?.includes(source)) {
      const name = CONNECTOR_SOURCE_NAMES[source]
      return `${source}: none of these start ${bot.name}, which has no ${name} connector (\`orca bot connectors --offer ${source}\` shows its owner a Connect card): ${AUTOMATION_EVENT_KINDS[source].map((event) => `${source}.${event}`).join(', ')}`
    }
    // GitHub's newer events and label=, and finished workflow runs, only where this bot's Orca Cloud
    // sends them.
    const older = source === 'github' && bot !== undefined && bot.githubEvents2 !== true
    const workflows = source === 'github' && (bot === undefined || bot.githubWorkflows === true)
    return [
      `${source}:`,
      ...offeredEvents(source, bot).map((event) => `  ${source}.${event}  when ${words[event]}`),
      `  in=<places>  only in these ${PLACE_WORDS[source]}, comma-separated`,
      `  subject=<one>  only ${SUBJECT_WORDS[source]}`,
      '  contains="<text>"  only when the text contains this (any case)',
      '  from=<people>  only these people: @name or their id, comma-separated; anyone by default',
      ...(source === 'github'
        ? [
            own.OWN_TRIGGER_OPTION,
            ...(older ? [] : ['  label=<name>  github.labeled only: only this label (any case)']),
            ...(workflows ? [RUN_TRIGGER_OPTION] : [])
          ]
        : []),
      ...(source === 'slack'
        ? ['  on=mine  slack.reaction only: only reactions on your own messages']
        : []),
      ...(SOURCE_NOTES[source] ? [`  ${SOURCE_NOTES[source]}`] : []),
      ...(workflows ? [`  ${WORKFLOW_WAIT_RECIPE}`] : []),
      ...(older
        ? [
            `  ${bot?.name ?? 'This bot'}'s Orca Cloud doesn't send ${GITHUB2_EVENT_KINDS.map((event) => `github.${event}`).join(', ')} or label= yet: to follow a pull request, wait on github.ci_failed, pr_merged, review, review_comment and comment until it updates.`
          ]
        : [])
    ].join('\n')
  })
  // A bot reads "you" as itself.
  return [
    '"You" below is the bot\'s owner.',
    ...(bot
      ? [
          "First run `orca bot connectors`: it lists each workspace the bot is in (and each Linear workspace's teams) as refs for in=, and `orca slack find <name>` finds one Slack channel by name. A workspace ref listens anywhere in that workspace; when the bot is in more than one, ask which."
        ]
      : []),
    ...(bot?.cloudSignedOut
      ? [
          `This computer is signed out of Orca, and Slack, GitHub, Linear and webhook events reach ${bot.name} through Orca Cloud: before saving one, run \`orca bot connectors --offer <source>\` so your owner sees a Sign in line in this chat, and save it once they say they're signed in. On a server with no Orca window, \`orca auth login\` on it signs it in.`
        ]
      : []),
    ...sources,
    "Nothing else can start an automation. For an event that isn't listed, tell your owner instead of polling for it on a schedule. This list grows as connectors and Orca update: run this again before saying an event can't start one.",
    "A run gets your prompt, then the event: its source, kind and time; for Slack, the channel id and message ts (and thread ts in a thread); then, quoted, who did it, where, a link and the text. With --results-to thread (the default when only these events start it), the run answers in the event's thread: `orca bot reply` posts there, and so does its final message. `orca skills get orca-cli --reference automations` has each source's fields."
  ].join('\n\n')
}

export function parseAutomationEventSource(
  raw: string | undefined
): AutomationEventSource | undefined {
  if (raw === undefined) {
    return undefined
  }
  if (!isKnownSource(raw)) {
    throw invalid(`--source must be one of ${ALL_SOURCES.join(', ')}`)
  }
  return raw
}
