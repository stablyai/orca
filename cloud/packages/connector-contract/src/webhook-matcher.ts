// The one webhook filter: the cloud runs it on each call, the host on stored calls (orca webhooks check)
// and for a run's picked fields. Desktop contract values are mirrored and checked for parity.

export const WEBHOOK_FILTER_LIMITS = {
  maxWhere: 8,
  maxValues: 10,
  maxPick: 12,
  maxPathLength: 200,
  maxValueLength: 200,
  // As every trigger event's subject. A longer value folds nothing, rather than folding on a prefix.
  maxSubjectLength: 256,
  // A rule's serialized UTF-8 JSON: maxHelloTriggers of them fit the desktop's 256 KiB trigger share of a hello.
  maxRuleBytes: 2560
} as const

// The receiver refuses a parsed body past these before matching or storing it: JSON.stringify
// recurses, so a deep body within the byte cap could exhaust the stack.
export const WEBHOOK_BODY_LIMITS = { maxDepth: 128, maxNodes: 100_000 } as const

/** `in` takes up to maxValues values; `=`, `!=` and `contains` one; `exists` and `!exists` none. */
export const WEBHOOK_WHERE_OPS = ['=', '!=', 'in', 'contains', 'exists', '!exists'] as const
export type WebhookWhereOp = (typeof WEBHOOK_WHERE_OPS)[number]

/** One clause, `path op values`. Clauses are ANDed; there is no OR. */
export type WebhookWhere = { path: string; op: WebhookWhereOp; values?: string[] }

/** A webhook rule's filters: `webhook.call where="…" contains=… pick=… subject-from=… subject=…`. */
export type WebhookFilters = {
  where?: WebhookWhere[]
  /** Case-insensitive, in the body's text; a JSON or form body is read as its JSON. */
  textContains?: string
  /** Fields quoted to the run, in this order. */
  pick?: string[]
  /** Where each call's subject is; later calls with the same subject fold into its open run. */
  subjectFrom?: string
  /** A fixed value the subject must equal, as for every trigger. */
  subject?: string
}

/**
 * What filters read: a call with the hook's own key scrubbed, header names in lower case. The body is
 * parsed JSON, a form as an object whose repeated keys are arrays, or any other body as its text. The
 * filters never throw on a body past WEBHOOK_BODY_LIMITS; contains= matches nothing in it.
 */
export type WebhookCallView = { headers: Readonly<Record<string, string>>; body: unknown }

type Step = string | number

const SEGMENT = /^([^.[\]\s]+)((?:\[\d{1,6}\])*)$/
// Refused when a rule is saved, so no path reaches into what an object inherits.
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor'])
const ROOTS = new Set(['body', 'headers'])

// "body.data.items[0].id": dot-separated keys, [n] for an array item. Keys holding a dot can't be named.
function pathSteps(path: string): Step[] | null {
  if (path.length === 0 || path.length > WEBHOOK_FILTER_LIMITS.maxPathLength) {
    return null
  }
  const steps: Step[] = []
  for (const part of path.split('.')) {
    const match = SEGMENT.exec(part)
    const key = match?.[1]
    if (key === undefined || FORBIDDEN_SEGMENTS.has(key)) {
      return null
    }
    // Header names match in any case, as in HTTP.
    steps.push(steps.length === 1 && steps[0] === 'headers' ? key.toLowerCase() : key)
    for (const [, index] of match?.[2]?.matchAll(/\[(\d+)\]/g) ?? []) {
      steps.push(Number(index))
    }
  }
  return typeof steps[0] === 'string' && ROOTS.has(steps[0]) ? steps : null
}

function valueAt(call: WebhookCallView, path: string): unknown {
  const steps = pathSteps(path)
  let value: unknown = steps ? call : undefined
  for (const step of steps ?? []) {
    if (typeof step === 'number') {
      value = Array.isArray(value) ? value[step] : undefined
    } else {
      // Own properties only.
      value =
        typeof value === 'object' && value !== null && !Array.isArray(value)
          ? Object.getOwnPropertyDescriptor(value, step)?.value
          : undefined
    }
  }
  return value
}

// Past 2^53 a JSON number may have lost digits, so two different ids could read as one.
const isExactNumber = (value: number) => Math.abs(value) <= Number.MAX_SAFE_INTEGER

function scalarText(value: unknown): string | null {
  if (typeof value === 'number') {
    return isExactNumber(value) ? String(value) : null
  }
  return typeof value === 'string' || typeof value === 'boolean' ? String(value) : null
}

const NUMBER = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/

// Strings compare exactly. Only a JSON number compares as a number, so 3 = "3.0" but "0042" != "42".
function equalsValue(item: unknown, expected: string): boolean {
  if (typeof item !== 'number') {
    return scalarText(item) === expected
  }
  const value = NUMBER.test(expected) ? Number(expected) : Number.NaN
  return isExactNumber(item) && isExactNumber(value) && item === value
}

const containsText = (text: string | null, needle: string) =>
  text !== null && text.toLowerCase().includes(needle.toLowerCase())

// Missing and null match only != and !exists. An array matches when any of its items does.
function whereMatches({ path, op, values = [] }: WebhookWhere, call: WebhookCallView): boolean {
  const value = valueAt(call, path)
  const present = value !== undefined && value !== null
  const items: unknown[] = Array.isArray(value) ? value : [value]
  const equal = () =>
    present && values.some((expected) => items.some((item) => equalsValue(item, expected)))
  switch (op) {
    case 'exists':
      return present
    case '!exists':
      return !present
    case '=':
    case 'in':
      return equal()
    case '!=':
      return !equal()
    case 'contains':
      return (
        present &&
        values.some((needle) => items.some((item) => containsText(scalarText(item), needle)))
      )
  }
}

/** The call's subject: the scalar at subjectFrom, or none. */
export function webhookCallSubject(
  filters: Pick<WebhookFilters, 'subjectFrom'>,
  call: WebhookCallView
): string | undefined {
  const text =
    filters.subjectFrom === undefined ? null : scalarText(valueAt(call, filters.subjectFrom))
  return text && text.length <= WEBHOOK_FILTER_LIMITS.maxSubjectLength ? text : undefined
}

/** Whether a parsed body is within WEBHOOK_BODY_LIMITS, walked without recursion. */
export function webhookBodyFits(body: unknown): boolean {
  const { maxDepth, maxNodes } = WEBHOOK_BODY_LIMITS
  const containers: { value: object; depth: number }[] = []
  const push = (value: unknown, depth: number) => {
    if (typeof value === 'object' && value !== null) {
      containers.push({ value, depth })
    }
  }
  push(body, 1)
  let nodes = 1
  for (let next = containers.pop(); next; next = containers.pop()) {
    const children = Object.values(next.value)
    nodes += children.length
    if (next.depth > maxDepth || nodes > maxNodes) {
      return false
    }
    for (const child of children) {
      push(child, next.depth + 1)
    }
  }
  return true
}

// contains= reads a JSON or form body as its JSON; one past the limits is never serialized.
function bodyText(body: unknown): string | null {
  if (typeof body === 'string') {
    return body
  }
  return webhookBodyFits(body) ? (JSON.stringify(body) ?? '') : null
}

/** Whether a call starts the rule. Run on the whole scrubbed body, before any of it is cut for storage. */
export function matchesWebhookCall(filters: WebhookFilters, call: WebhookCallView): boolean {
  return (
    (filters.where ?? []).every((clause) => whereMatches(clause, call)) &&
    (!filters.textContains || containsText(bodyText(call.body), filters.textContains)) &&
    // In any case, as subject= matches for every trigger.
    (!filters.subject ||
      filters.subject.toLowerCase() === webhookCallSubject(filters, call)?.toLowerCase())
  )
}

/** The picked fields the call has, in the rule's order; the host quotes them within the event text's cap. */
export function webhookPicks(
  filters: Pick<WebhookFilters, 'pick'>,
  call: WebhookCallView
): { path: string; value: unknown }[] {
  return (filters.pick ?? []).flatMap((path) => {
    const value = valueAt(call, path)
    return value === undefined ? [] : [{ path, value }]
  })
}

function arityProblem({ path, op, values = [] }: WebhookWhere): string | null {
  const [least, most, words] =
    op === 'in'
      ? [1, WEBHOOK_FILTER_LIMITS.maxValues, `1 to ${WEBHOOK_FILTER_LIMITS.maxValues} values`]
      : op === 'exists' || op === '!exists'
        ? [0, 0, 'no value']
        : [1, 1, 'one value']
  return values.length < least || values.length > most
    ? `where="${path} ${op}" takes ${words}.`
    : null
}

/** Why the filters can't be saved, in words a bot can act on; null when they can. */
export function webhookFiltersProblem(filters: WebhookFilters): string | null {
  const { maxWhere, maxPick, maxValueLength } = WEBHOOK_FILTER_LIMITS
  const where = filters.where ?? []
  const pick = filters.pick ?? []
  if (where.length > maxWhere || pick.length > maxPick) {
    return `A webhook takes at most ${maxWhere} where= clauses and ${maxPick} pick= paths.`
  }
  const paths = [
    ...where.map(({ path }) => path),
    ...pick,
    ...(filters.subjectFrom === undefined ? [] : [filters.subjectFrom])
  ]
  const badPath = paths.find((path) => !pathSteps(path))
  if (badPath !== undefined) {
    return `"${badPath}" isn't a path. Start at body or headers, join keys with dots and write array items as [0]; __proto__, prototype and constructor can't be named.`
  }
  const arity = where.map(arityProblem).find((problem) => problem !== null)
  if (arity) {
    return arity
  }
  const texts = [
    ...where.flatMap(({ values = [] }) => values),
    ...[filters.textContains, filters.subject].filter((text) => text !== undefined)
  ]
  if (texts.some((text) => text.length === 0 || text.length > maxValueLength)) {
    return `Each value, contains= and subject= takes 1 to ${maxValueLength} characters.`
  }
  if (filters.subject !== undefined && filters.subjectFrom === undefined) {
    return "subject= needs subject-from=, which says where each call's subject is."
  }
  return null
}

/** A rule's size in a hello: its serialized UTF-8 JSON. */
export function webhookRuleBytes(rule: object): number {
  return new TextEncoder().encode(JSON.stringify(rule)).length
}
