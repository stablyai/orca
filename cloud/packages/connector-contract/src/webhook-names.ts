// Names the cloud and the machine share for webhooks; desktop values have a parity-tested mirror.

// Minted by the cloud. A hook's rule on its host is webhookRuleId(hookId); its calls' actor is webhookActorId(hookId).
export const WEBHOOK_HOOK_ID_PATTERN = /^wh_[A-Za-z0-9]{16}$/
export const WEBHOOK_CALL_ID_PATTERN = /^call_[A-Za-z0-9]{20}$/

// 256 random bits, base64url. The prefix lets secret scanners and the outbound redaction find a key anywhere.
export const WEBHOOK_KEY_PREFIX = 'orcawh_'
export const WEBHOOK_KEY_PATTERN = /^orcawh_[A-Za-z0-9_-]{43}$/

// Callers POST to <base>/hooks/<hookId> with the key as a Bearer token, or to <base>/hooks/<hookId>/<key>.
export const WEBHOOK_PATH_PREFIX = '/hooks/'

export function webhookPath(hookId: string, key?: string): string {
  return `${WEBHOOK_PATH_PREFIX}${hookId}${key === undefined ? '' : `/${key}`}`
}

const RULE_ID_PREFIX = 'wh-'
const ACTOR_ID_PREFIX = 'webhook:'

function hookIdAfter(prefix: string, id: string): string | null {
  const hookId = id.startsWith(prefix) ? id.slice(prefix.length) : ''
  return WEBHOOK_HOOK_ID_PATTERN.test(hookId) ? hookId : null
}

export function webhookRuleId(hookId: string): string {
  return `${RULE_ID_PREFIX}${hookId}`
}

/** The hook a rule id names, or null for any other rule. */
export function hookIdOfRule(ruleId: string): string | null {
  return hookIdAfter(RULE_ID_PREFIX, ruleId)
}

export function webhookActorId(hookId: string): string {
  return `${ACTOR_ID_PREFIX}${hookId}`
}

/** The hook a trigger event's actor names, or null for a person. */
export function hookIdOfActor(actorId: string): string | null {
  return hookIdAfter(ACTOR_ID_PREFIX, actorId)
}

// A key character's code, for its percent-encoded and JSON-escaped forms: 0-9, A-Z, a-z, _ and -.
const KEY_CHAR_CODE = '(?:3[0-9]|[46][1-9A-Fa-f]|[57][0-9Aa]|5[Ff]|2[Dd])'
// Markdown escapes _ and -.
const KEY_CHAR = String.raw`(?:[A-Za-z0-9_-]|\\[_-]|(?:%|\\u00)${KEY_CHAR_CODE})`

// A prefix character as written, Markdown-escaped, percent-encoded or JSON-escaped.
function writtenAs(char: string): string {
  const hex = char.charCodeAt(0).toString(16)
  const code = `${hex[0]}[${hex[1]?.toLowerCase()}${hex[1]?.toUpperCase()}]`
  const markdown = char === '_' ? String.raw`|\\_` : ''
  return String.raw`(?:${char}${markdown}|(?:%|\\u00)${code})`
}

// Any key token, as written or in the encodings ordinary output uses, and whatever follows a hook id
// in a URL path. Catches a key quoted by mistake, not one deliberately disguised.
const KEY_TOKEN = `${[...WEBHOOK_KEY_PREFIX].map(writtenAs).join('')}${KEY_CHAR}+`
const KEY_IN_PATH = String.raw`(?<=\/hooks\/wh_[A-Za-z0-9]{16}\/)[^\s/?#"'<>)\]]+`
const KEY_IN_TEXT = new RegExp(`${KEY_TOKEN}|${KEY_IN_PATH}`, 'g')

/** What a webhook key becomes in a stored call or an outbound post. */
export const REDACTED_WEBHOOK_KEY = '[orca webhook key]'

/** The text with every webhook key in it replaced, for text that leaves Orca. */
export function redactWebhookKeys(text: string, replacement = REDACTED_WEBHOOK_KEY): string {
  return text.replace(KEY_IN_TEXT, replacement)
}

/** Senders whose signatures the cloud checks natively; a hook without one is key-only. */
export const WEBHOOK_ADAPTERS = [
  'standard',
  'github',
  'sentry',
  'linear',
  'pagerduty',
  'stripe'
] as const
export type WebhookAdapterId = (typeof WEBHOOK_ADAPTERS)[number]

/** What a caller's 200 says: {callId, status}. None of them means the run is done. */
export const WEBHOOK_RECEIPT_STATUSES = ['queued', 'ignored', 'duplicate', 'paused'] as const
export type WebhookReceiptStatus = (typeof WEBHOOK_RECEIPT_STATUSES)[number]

/**
 * Runs started per exact rolling hour: a hook's own cap (the owner may set 1 up to the default), and
 * its account's, of which one hook takes at most 2/3.
 */
export const WEBHOOK_RUN_CAPS = { hookDefault: 200, account: 300 } as const

/**
 * A call's state, in the words of the automation's run history. The cloud keeps its own part:
 * queued, delivered or started, then refused, missed, unavailable or cancelled; the host keeps how its
 * run went.
 */
export const WEBHOOK_CALL_STATES = [
  'queued',
  'ignored',
  'paused',
  'delivered',
  'cancelled',
  'waiting_capacity',
  'started',
  'folded',
  'refused',
  'missed',
  'unavailable',
  'completed',
  'failed',
  'unverifiable'
] as const
export type WebhookCallState = (typeof WEBHOOK_CALL_STATES)[number]
