// Worker and Durable Object errors from Cloudflare's GraphQL Analytics API, for the
// cloudflare-errors rule (alerts-rules.ts). Catches what the edge's own metrics cannot: an isolate
// that throws, exceeds its limits or hits an internal error never writes its data point.
// One small query covers both windows. Statuses other than success and a client going away count
// as errors (websocket peers disconnecting is normal traffic).
import type { AlertsEnv, Counts } from './alerts-rules'

const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql'
const OK_STATUSES = new Set(['success', 'clientDisconnected', 'responseStreamDisconnected'])
export const DEFAULT_SCRIPT_NAME = 'orca-relay-edge'

type Group = { sum?: { requests?: number }; dimensions?: { status?: string; namespaceId?: string; type?: string } }

const workers = (alias: string, range: string) =>
  `${alias}:workersInvocationsAdaptive(limit:50,filter:{scriptName:$script,${range}}){sum{requests} dimensions{status}}`
const objects = (alias: string, range: string) =>
  `${alias}:durableObjectsInvocationsAdaptiveGroups(limit:200,filter:{namespaceId_in:$ns,${range}}){sum{requests} dimensions{namespaceId type status}}`

export function cloudflareQuery(withObjects: boolean): string {
  const now = 'datetime_geq:$s0,datetime_lt:$e0'
  const before = 'datetime_geq:$s1,datetime_lt:$e1'
  const parts = [workers('w0', now), workers('w1', before), ...(withObjects ? [objects('o0', now), objects('o1', before)] : [])]
  // Only the configured namespaces, so other objects on the account never use up the group limit.
  const ns = withObjects ? ',$ns:[String!]!' : ''
  return `query($a:String!,$script:String!,$s0:Time!,$e0:Time!,$s1:Time!,$e1:Time!${ns}){viewer{accounts(filter:{accountTag:$a}){${parts.join(' ')}}}}`
}

// skipHibernationErrors: a throwing hibernated WebSocket event (close, message, error) still counts
// as an invocation, not an error.
export type CloudflareErrorsOptions = { skipHibernationErrors?: boolean }

function tally(groups: Group[] | undefined, namespaces?: Set<string>, options: CloudflareErrorsOptions = {}): Counts {
  let invocations = 0
  let errors = 0
  for (const group of groups ?? []) {
    if (namespaces && !namespaces.has(group.dimensions?.namespaceId ?? '')) { continue }
    const requests = group.sum?.requests ?? 0
    invocations += requests
    if (options.skipHibernationErrors && group.dimensions?.type === 'hibernation') { continue }
    if (!OK_STATUSES.has(group.dimensions?.status ?? '')) { errors += requests }
  }
  return { cf_invocations: invocations, cf_errors: errors }
}

const MAX_FIELD = 200
const MAX_TEXT = 500

// Bounded, with the account id and token scrubbed: Cloudflare's error text can echo them.
function clean(value: unknown, secrets: string[], max = MAX_FIELD): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') { return undefined }
  const text = secrets.reduce((out, secret) => out.split(secret).join('[redacted]'), String(value))
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

// One line per failed read, every run: the hourly warning alone loses the reason. Never throws, so
// the original failure is always what the caller sees.
function readFailed(reason: string, script: string, status: number, startedMs: number, secrets: string[], errors: unknown = []): Error {
  const list: unknown[] = Array.isArray(errors) ? errors.slice(0, 5) : []
  const detail = list.map((e) => {
    const item = (e && typeof e === 'object' ? e : {}) as { message?: unknown; path?: unknown; extensions?: { code?: unknown } }
    const path = Array.isArray(item.path) ? item.path.slice(0, 10).map((part) => clean(part, secrets, 64) ?? '?') : undefined
    return { message: clean(item.message, secrets), path, code: clean(item.extensions?.code, secrets, 64) }
  })
  try {
    console.error(`cloudflare analytics read failed ${JSON.stringify({ reason, script, status, durationMs: Date.now() - startedMs, errors: detail })}`)
  } catch {
    // Logging is best effort.
  }
  const text = clean(detail.map((e) => [e.code, e.message].filter(Boolean).join(': ')).filter(Boolean).join('; '), [], MAX_TEXT)
  return new Error(text ? `${reason}: ${text}` : reason)
}

const add = (a: Counts, b: Counts): Counts => ({
  cf_invocations: a.cf_invocations + b.cf_invocations,
  cf_errors: a.cf_errors + b.cf_errors
})

// [current window, previous window], with the same 2-min ingestion lag as the Analytics Engine
// queries; null when the rule is not configured. Throws when the API cannot be read.
export async function cloudflareErrors(env: AlertsEnv, windowMin: number, lagMin: number, nowMs = Date.now(), options: CloudflareErrorsOptions = {}): Promise<[Counts, Counts] | null> {
  // The Analytics Engine read token also carries Account Analytics: Read when CF_GRAPHQL_USE_AE_TOKEN=1.
  const token = env.CF_GRAPHQL_TOKEN ?? (env.CF_GRAPHQL_USE_AE_TOKEN === '1' ? env.AE_READ_TOKEN : undefined)
  if (!token) { return null }
  const namespaceIds = (env.CF_DO_NAMESPACE_IDS ?? '').split(',').map((id) => id.trim()).filter(Boolean)
  const namespaces = namespaceIds.length > 0 ? new Set(namespaceIds) : undefined
  const at = (minutes: number) => new Date(nowMs - minutes * 60_000).toISOString()
  const script = env.CF_SCRIPT_NAME || DEFAULT_SCRIPT_NAME
  const startedMs = Date.now()
  const secrets = [token, env.ACCOUNT_ID].filter((value): value is string => typeof value === 'string' && value.length > 0)
  const response = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      query: cloudflareQuery(namespaces !== undefined),
      variables: {
        a: env.ACCOUNT_ID,
        script,
        ...(namespaces ? { ns: namespaceIds } : {}),
        s0: at(windowMin + lagMin),
        e0: at(lagMin),
        s1: at(2 * windowMin + lagMin),
        e1: at(windowMin + lagMin)
      }
    })
  })
  if (!response.ok) { throw readFailed(`cloudflare analytics query failed: ${response.status}`, script, response.status, startedMs, secrets) }
  const body = (await response.json()) as {
    data?: { viewer?: { accounts?: Record<string, Group[] | undefined>[] } }
    errors?: unknown
  }
  const account = body.data?.viewer?.accounts?.[0]
  if ((Array.isArray(body.errors) && body.errors.length > 0) || !account) { throw readFailed('cloudflare analytics query returned errors', script, response.status, startedMs, secrets, body.errors) }
  return [
    add(tally(account.w0), namespaces ? tally(account.o0, namespaces, options) : tally([])),
    add(tally(account.w1), namespaces ? tally(account.o1, namespaces, options) : tally([]))
  ]
}
