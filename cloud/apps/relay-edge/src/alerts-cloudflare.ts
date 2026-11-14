// Worker and Durable Object errors from Cloudflare's GraphQL Analytics API, for the
// cloudflare-errors rule (alerts-rules.ts). Catches what the edge's own metrics cannot: an isolate
// that throws, exceeds its limits or hits an internal error never writes its data point.
// One small query covers both windows. Statuses other than success and a client going away count
// as errors (websocket peers disconnecting is normal traffic).
import type { AlertsEnv, Counts } from './alerts-rules'

const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql'
const OK_STATUSES = new Set(['success', 'clientDisconnected', 'responseStreamDisconnected'])
export const DEFAULT_SCRIPT_NAME = 'orca-relay-edge'

type Group = { sum?: { requests?: number }; dimensions?: { status?: string; namespaceId?: string } }

const workers = (alias: string, range: string) =>
  `${alias}:workersInvocationsAdaptive(limit:50,filter:{scriptName:$script,${range}}){sum{requests} dimensions{status}}`
const objects = (alias: string, range: string) =>
  `${alias}:durableObjectsInvocationsAdaptiveGroups(limit:200,filter:{${range}}){sum{requests} dimensions{namespaceId status}}`

export function cloudflareQuery(withObjects: boolean): string {
  const now = 'datetime_geq:$s0,datetime_lt:$e0'
  const before = 'datetime_geq:$s1,datetime_lt:$e1'
  const parts = [workers('w0', now), workers('w1', before), ...(withObjects ? [objects('o0', now), objects('o1', before)] : [])]
  return `query($a:String!,$script:String!,$s0:Time!,$e0:Time!,$s1:Time!,$e1:Time!){viewer{accounts(filter:{accountTag:$a}){${parts.join(' ')}}}}`
}

function tally(groups: Group[] | undefined, namespaces?: Set<string>): Counts {
  let invocations = 0
  let errors = 0
  for (const group of groups ?? []) {
    if (namespaces && !namespaces.has(group.dimensions?.namespaceId ?? '')) { continue }
    const requests = group.sum?.requests ?? 0
    invocations += requests
    if (!OK_STATUSES.has(group.dimensions?.status ?? '')) { errors += requests }
  }
  return { cf_invocations: invocations, cf_errors: errors }
}

const add = (a: Counts, b: Counts): Counts => ({
  cf_invocations: a.cf_invocations + b.cf_invocations,
  cf_errors: a.cf_errors + b.cf_errors
})

// [current window, previous window], with the same 2-min ingestion lag as the Analytics Engine
// queries; null when the rule is not configured. Throws when the API cannot be read.
export async function cloudflareErrors(env: AlertsEnv, windowMin: number, lagMin: number, nowMs = Date.now()): Promise<[Counts, Counts] | null> {
  // The Analytics Engine read token also carries Account Analytics: Read when CF_GRAPHQL_USE_AE_TOKEN=1.
  const token = env.CF_GRAPHQL_TOKEN ?? (env.CF_GRAPHQL_USE_AE_TOKEN === '1' ? env.AE_READ_TOKEN : undefined)
  if (!token) { return null }
  const namespaceIds = (env.CF_DO_NAMESPACE_IDS ?? '').split(',').map((id) => id.trim()).filter(Boolean)
  const namespaces = namespaceIds.length > 0 ? new Set(namespaceIds) : undefined
  const at = (minutes: number) => new Date(nowMs - minutes * 60_000).toISOString()
  const response = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      query: cloudflareQuery(namespaces !== undefined),
      variables: {
        a: env.ACCOUNT_ID,
        script: env.CF_SCRIPT_NAME || DEFAULT_SCRIPT_NAME,
        s0: at(windowMin + lagMin),
        e0: at(lagMin),
        s1: at(2 * windowMin + lagMin),
        e1: at(windowMin + lagMin)
      }
    })
  })
  if (!response.ok) { throw new Error(`cloudflare analytics query failed: ${response.status}`) }
  const body = (await response.json()) as {
    data?: { viewer?: { accounts?: Record<string, Group[] | undefined>[] } }
    errors?: unknown[] | null
  }
  const account = body.data?.viewer?.accounts?.[0]
  if ((body.errors && body.errors.length > 0) || !account) { throw new Error('cloudflare analytics query returned errors') }
  return [
    add(tally(account.w0), namespaces ? tally(account.o0, namespaces) : tally([])),
    add(tally(account.w1), namespaces ? tally(account.o1, namespaces) : tally([]))
  ]
}
