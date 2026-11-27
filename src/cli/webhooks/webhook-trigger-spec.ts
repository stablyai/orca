// `--on 'webhook.call where="<path> <op> [values]" contains=… pick=<path>,… subject-from=<path> subject=…'`.
import type { AutomationWebhookTrigger } from '../../shared/automation-event-triggers'
import { WEBHOOK_WHERE_OPS, type WebhookWhere } from '../../shared/connector-webhook-contract'
import { RuntimeClientError } from '../runtime/connection/types'

const KEYS = ['where', 'contains', 'pick', 'subject-from', 'subject'] as const
type Key = (typeof KEYS)[number]

function invalid(message: string): RuntimeClientError {
  return new RuntimeClientError('invalid_argument', message)
}

const WHERE = /^(\S+)\s+(\S+)(?:\s+(.*))?$/s

function whereOf(spec: string, raw: string): WebhookWhere {
  const [, path = '', rawOp, value = ''] = WHERE.exec(raw.trim()) ?? []
  const op = WEBHOOK_WHERE_OPS.find((candidate) => candidate === rawOp)
  if (!op) {
    throw invalid(
      `--on "${spec}": where= takes "<path> <op> <value>", with op one of ${WEBHOOK_WHERE_OPS.join(', ')}.`
    )
  }
  if (op === 'exists' || op === '!exists') {
    return { path, op }
  }
  // Only `in` lists values; a single value may hold commas.
  const values = op === 'in' ? value.split(',').map((entry) => entry.trim()) : [value.trim()]
  return { path, op, values }
}

/** The webhook rule an --on asks for; the host makes the hook and fills in its id and rev. */
export function parseWebhookTrigger(
  spec: string,
  filters: readonly (readonly [key: string, value: string, ...written: string[]])[]
): AutomationWebhookTrigger {
  const where: WebhookWhere[] = []
  const once = new Map<Exclude<Key, 'where'>, string>()
  for (const [key, value] of filters) {
    const known = KEYS.find((entry) => entry === key)
    if (!known) {
      throw invalid(
        `Unknown filter "${key}=" in --on "${spec}". Use where=, contains=, pick=, subject-from= or subject=.`
      )
    }
    if (known === 'where') {
      where.push(whereOf(spec, value))
      continue
    }
    if (once.has(known) || !value) {
      throw invalid(`--on "${spec}" needs one value for ${known}=.`)
    }
    once.set(known, value)
  }
  const pick = once
    .get('pick')
    ?.split(',')
    .map((path) => path.trim())
  const trigger: AutomationWebhookTrigger = Object.assign(
    { id: '', source: 'webhook' as const, event: 'call' as const, rev: 0 },
    where.length > 0 ? { where } : {},
    once.has('contains') ? { textContains: once.get('contains') } : {},
    pick ? { pick } : {},
    once.has('subject-from') ? { subjectFrom: once.get('subject-from') } : {},
    once.has('subject') ? { subject: once.get('subject') } : {}
  )
  // The host checks paths, values and size against the one matcher.
  return trigger
}

function quoteValue(value: string): string {
  return /[\s"\\]/.test(value) ? `"${value.replace(/["\\]/g, '\\$&')}"` : value
}

function whereText({ path, op, values }: WebhookWhere): string {
  return [path, op, ...(values?.length ? [values.join(',')] : [])].join(' ')
}

/** The rule as an --on value; parsing it gives the same filters back. */
export function formatWebhookTrigger(trigger: AutomationWebhookTrigger): string {
  return [
    'webhook.call',
    ...(trigger.where ?? []).map((clause) => `where=${quoteValue(whereText(clause))}`),
    ...(trigger.textContains ? [`contains=${quoteValue(trigger.textContains)}`] : []),
    ...(trigger.pick?.length ? [`pick=${trigger.pick.join(',')}`] : []),
    ...(trigger.subjectFrom ? [`subject-from=${trigger.subjectFrom}`] : []),
    ...(trigger.subject ? [`subject=${quoteValue(trigger.subject)}`] : [])
  ].join(' ')
}

/** "its webhook is called, where body.action = opened, containing "deploy"". */
export function describeWebhookTrigger(trigger: AutomationWebhookTrigger): string {
  return [
    'its webhook is called',
    ...(trigger.where ?? []).map((clause) => `where ${whereText(clause)}`),
    ...(trigger.subject ? [`on ${trigger.subject}`] : []),
    ...(trigger.textContains ? [`containing "${trigger.textContains}"`] : [])
  ].join(', ')
}

export const WEBHOOK_TRIGGER_OPTIONS = [
  'webhook:',
  "  webhook.call  when the automation's webhook URL is called. The automation gets its own URL; anyone with it can start a run.",
  '  where="<path> <op> <value>"  only when the call matches; repeatable, all must match. Paths start at body or headers (body.action, headers.x-github-event, body.items[0].id); every header is there but credentials, signatures, cookies and ones a proxy added; op is =, !=, in (comma-separated values), contains, exists or !exists',
  '  contains="<text>"  only when the body contains this (any case)',
  "  pick=<path>,<path>  quote only these fields to the run; the full body is in a file in the bot's folder",
  "  subject-from=<path>  calls with the same value here fold into that subject's unfinished run",
  '  subject=<value>  only calls whose subject-from value is this',
  "  Your owner copies the URL with Copy URL on the automation's card in Orca. Never write a webhook URL yourself, and never ask for, repeat or accept a webhook key."
].join('\n')
