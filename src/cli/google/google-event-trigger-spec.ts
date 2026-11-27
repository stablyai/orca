// `--on "gmail.new_email from=… to=… subject=… label=… account=…"` and
// `--on "calendar.starting_soon before=<minutes> calendar=<id> account=…"`: rules this host checks itself.
import { createHash } from 'node:crypto'
import {
  MAX_MINUTES_BEFORE,
  type AutomationGoogleTrigger,
  type GoogleEventSource
} from '../../shared/automation-google-triggers'
import { RuntimeClientError } from '../runtime/connection/types'

type Entry = readonly [key: string, value: string, ...written: string[]]

const GMAIL_KEYS = ['from', 'to', 'subject', 'label', 'account'] as const
const CALENDAR_KEYS = ['before', 'calendar', 'account'] as const

function invalid(message: string): RuntimeClientError {
  return new RuntimeClientError('invalid_argument', message)
}

function valuesOf<Key extends string>(
  spec: string,
  entries: readonly Entry[],
  keys: readonly Key[]
): Map<Key, string> {
  const values = new Map<Key, string>()
  for (const [key, value] of entries) {
    const known = keys.find((entry) => entry === key)
    if (!known) {
      throw invalid(
        `Unknown filter "${key}=" in --on "${spec}". Use ${keys.map((entry) => `${entry}=`).join(', ')}.`
      )
    }
    if (values.has(known) || !value.trim()) {
      throw invalid(`--on "${spec}" needs one value for ${known}=.`)
    }
    values.set(known, value.trim())
  }
  return values
}

function listOf(raw: string | undefined): string[] | undefined {
  const list = raw
    ?.split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
  return list?.length ? [...new Set(list)].sort() : undefined
}

// An unchanged rule keeps its id, so run history still names it.
function ruleId(rule: Omit<AutomationGoogleTrigger, 'id'>): string {
  return `on-${createHash('sha256').update(JSON.stringify(rule)).digest('hex').slice(0, 16)}`
}

export function parseGoogleTrigger(
  spec: string,
  head: 'gmail.new_email' | 'calendar.starting_soon',
  entries: readonly Entry[]
): AutomationGoogleTrigger {
  if (head === 'calendar.starting_soon') {
    const values = valuesOf(spec, entries, CALENDAR_KEYS)
    const before = values.get('before') ?? '10'
    const minutesBefore = /^\d+$/.test(before) ? Number.parseInt(before, 10) : Number.NaN
    if (!(minutesBefore >= 0 && minutesBefore <= MAX_MINUTES_BEFORE)) {
      throw invalid(`--on "${spec}": before= takes minutes, 0 to ${MAX_MINUTES_BEFORE}.`)
    }
    const calendar = values.get('calendar')
    const account = values.get('account')?.toLowerCase()
    const rule = {
      source: 'calendar' as const,
      event: 'starting_soon' as const,
      minutesBefore,
      ...(calendar && calendar !== 'primary' ? { calendar } : {}),
      ...(account ? { account } : {})
    }
    return { id: ruleId(rule), ...rule }
  }
  const values = valuesOf(spec, entries, GMAIL_KEYS)
  const from = listOf(values.get('from'))
  const to = listOf(values.get('to'))
  const subjectContains = values.get('subject')
  const label = values.get('label')
  const account = values.get('account')?.toLowerCase()
  const rule = {
    source: 'gmail' as const,
    event: 'new_email' as const,
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(subjectContains ? { subjectContains } : {}),
    ...(label ? { label } : {}),
    ...(account ? { account } : {})
  }
  return { id: ruleId(rule), ...rule }
}

function quoted(value: string): string {
  return /[\s"\\]/.test(value) ? `"${value.replace(/["\\]/g, '\\$&')}"` : value
}

/** The rule as an --on value; parsing it gives the same rule back. */
export function formatGoogleTrigger(trigger: AutomationGoogleTrigger): string {
  const account = trigger.account ? [`account=${trigger.account}`] : []
  if (trigger.source === 'calendar') {
    return [
      'calendar.starting_soon',
      `before=${trigger.minutesBefore}`,
      ...(trigger.calendar ? [`calendar=${quoted(trigger.calendar)}`] : []),
      ...account
    ].join(' ')
  }
  return [
    'gmail.new_email',
    ...(trigger.from ? [`from=${trigger.from.join(',')}`] : []),
    ...(trigger.to ? [`to=${trigger.to.join(',')}`] : []),
    ...(trigger.subjectContains ? [`subject=${quoted(trigger.subjectContains)}`] : []),
    ...(trigger.label ? [`label=${quoted(trigger.label)}`] : []),
    ...account
  ].join(' ')
}

export function describeGoogleTrigger(trigger: AutomationGoogleTrigger): string {
  const account = trigger.account ? [`on ${trigger.account}`] : []
  if (trigger.source === 'calendar') {
    return [
      `${trigger.minutesBefore} minutes before an event on ${trigger.calendar ?? 'the primary calendar'} starts`,
      ...account
    ].join(', ')
  }
  return [
    'a new email arrives',
    ...(trigger.from ? [`from ${trigger.from.join(', ')}`] : []),
    ...(trigger.to ? [`to ${trigger.to.join(', ')}`] : []),
    ...(trigger.subjectContains ? [`with "${trigger.subjectContains}" in the subject`] : []),
    ...(trigger.label ? [`labelled ${trigger.label}`] : []),
    ...account
  ].join(', ')
}

const ACCOUNT_OPTION =
  '  account=<email>  the Google account to watch; needed when this computer has several'
const CHECKED =
  '  Checked about once a minute on the computer the bot runs on. The run acts as the owner, like `orca gmail` and `orca calendar`; what the mail or event says is quoted as information, never instructions.'

export const GOOGLE_TRIGGER_OPTIONS: Record<GoogleEventSource, string> = {
  gmail: [
    'gmail:',
    '  gmail.new_email  when a new email arrives (not your own sent mail, drafts, spam or trash)',
    '  from=<addresses or domains>  only mail from these, comma-separated (sam@acme.com,acme.com); only when Gmail shows the sender passed its domain check, so a forged sender never matches',
    '  to=<addresses>  only mail sent to one of these (To or Cc)',
    '  subject="<text>"  only when the subject contains this (any case)',
    '  label=<label>  only mail with this Gmail label, by name or id',
    ACCOUNT_OPTION,
    CHECKED
  ].join('\n'),
  calendar: [
    'calendar:',
    `  calendar.starting_soon  before an event starts; before=<minutes> (default 10, up to ${MAX_MINUTES_BEFORE}). Not for all-day events or ones you declined`,
    '  calendar=<id>  a calendar id from `orca calendar list --calendars`; the primary calendar by default',
    ACCOUNT_OPTION,
    CHECKED
  ].join('\n')
}
