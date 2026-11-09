// Unauthenticated routine triggers (the secret in the URL / the HMAC is the credential):
//   POST /v1/hooks/<token>       secret webhook URL; optional JSON body (<= 16 KB) -> 202 {runId}
//   POST /v1/github/webhook      GitHub App deliveries (X-Hub-Signature-256)       -> 202 {matched, runIds}
import { consumeRate, RateLimitedError } from '../api/audit'
import { sha256Hex } from '../api/keys'
import { parseGitHubRepo } from '../github-app'
import { timingSafeEqual } from '../github-connect'
import { RunRefusedError, enqueueRun, type RunDetail } from './runs'
import {
  GITHUB_EVENTS,
  getRoutineByWebhookId,
  triggerConfig,
  webhookIdOf,
  type GitHubConfig,
  type GitHubEventKey,
  type RoutineRecord
} from './store'

export const MAX_WEBHOOK_BODY_BYTES = 16 * 1024
const MAX_GITHUB_BODY_BYTES = 4 * 1024 * 1024
export const WEBHOOK_RUNS_PER_MINUTE = 10
const CONTEXT_TEXT_CHARS = 8_000

export type HookDeps = {
  db: D1Database
  now: () => number
  /** GITHUB_WEBHOOK_SECRET; GitHub deliveries answer 503 without it. */
  githubWebhookSecret?: string
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } })
}

async function readCapped(request: Request, max: number): Promise<string | null> {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (declared > max) {
    return null
  }
  const text = await request.text()
  return new TextEncoder().encode(text).byteLength > max ? null : text
}

export function isRoutineHookPath(pathname: string): boolean {
  return pathname.startsWith('/v1/hooks/') || pathname === '/v1/github/webhook'
}

export async function handleRoutineHook(request: Request, url: URL, deps: HookDeps): Promise<Response> {
  if (request.method !== 'POST') {
    return json({ error: 'not_found' }, 404)
  }
  if (url.pathname === '/v1/github/webhook') {
    return githubWebhook(request, deps)
  }
  return secretWebhook(request, url, deps)
}

// Secret webhook URL ---------------------------------------------------------------------------

async function secretWebhook(request: Request, url: URL, deps: HookDeps): Promise<Response> {
  const token = decodeURIComponent(url.pathname.slice('/v1/hooks/'.length))
  const webhookId = webhookIdOf(token)
  const routine = webhookId ? await getRoutineByWebhookId(deps.db, webhookId) : null
  // Unknown, rotated and wrong-secret URLs all look the same.
  if (
    !routine ||
    routine.trigger_kind !== 'webhook' ||
    !routine.webhook_secret_hash ||
    !timingSafeEqual(new TextEncoder().encode(await sha256Hex(token)), new TextEncoder().encode(routine.webhook_secret_hash))
  ) {
    return json({ error: 'not_found' }, 404)
  }
  if (routine.enabled !== 1) {
    return json({ error: 'conflict', reason: 'routine_disabled' }, 409)
  }
  const now = deps.now()
  try {
    await consumeRate(deps.db, `hook:${routine.id}`, WEBHOOK_RUNS_PER_MINUTE, now)
  } catch (error) {
    if (error instanceof RateLimitedError) {
      return json({ error: 'rate_limited' }, 429, { 'retry-after': String(error.retryAfterSeconds) })
    }
    throw error
  }
  const text = await readCapped(request, MAX_WEBHOOK_BODY_BYTES)
  if (text === null) {
    return json({ error: 'payload_too_large', limitBytes: MAX_WEBHOOK_BODY_BYTES }, 413)
  }
  let payload: unknown
  if (text.trim()) {
    try {
      payload = JSON.parse(text)
    } catch {
      return json({ error: 'invalid_json' }, 400)
    }
  }
  const idempotencyKey = request.headers.get('idempotency-key')
  if (idempotencyKey !== null && !/^[\x21-\x7e]{1,128}$/.test(idempotencyKey)) {
    return json({ error: 'invalid_request', reason: 'idempotency_key' }, 400)
  }
  const dedupeKey = idempotencyKey ? `webhook:${routine.id}:${idempotencyKey}` : null
  try {
    const run = await enqueueRun(
      deps.db,
      routine,
      { trigger: 'webhook', detail: { ...(payload !== undefined ? { context: payload } : {}), ...(idempotencyKey ? { idempotencyKey } : {}) } as RunDetail, dedupeKey },
      now
    )
    return json({ runId: run.id }, 202)
  } catch (error) {
    if (error instanceof RunRefusedError) {
      if (error.reason === 'duplicate' && dedupeKey) {
        const existing = await deps.db.prepare('SELECT id FROM routine_runs WHERE dedupe_key = ?').bind(dedupeKey).first<{ id: string }>()
        return json({ runId: existing?.id ?? null, duplicate: true }, 200)
      }
      return json({ error: 'rate_limited', reason: error.reason }, 429, { 'retry-after': '60' })
    }
    throw error
  }
}

// GitHub App deliveries ------------------------------------------------------------------------

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))
  return Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function verifyGitHubSignature(secret: string, body: string, header: string | null): Promise<boolean> {
  const match = /^sha256=([0-9a-f]{64})$/.exec(header ?? '')
  if (!match) {
    return false
  }
  return timingSafeEqual(new TextEncoder().encode(await hmacHex(secret, body)), new TextEncoder().encode(match[1]!))
}

type Labeled = { name?: string }
type GitHubItem = {
  number?: number
  title?: string
  body?: string | null
  html_url?: string
  user?: { login?: string; type?: string }
  labels?: Labeled[]
  pull_request?: unknown
  base?: { ref?: string; repo?: { full_name?: string } }
  head?: { ref?: string; repo?: { full_name?: string } | null }
}
export type GitHubPayload = {
  action?: string
  installation?: { id?: number }
  repository?: { full_name?: string; html_url?: string }
  sender?: { login?: string; type?: string }
  pull_request?: GitHubItem
  issue?: GitHubItem
  label?: Labeled
  comment?: { body?: string; html_url?: string; user?: { login?: string } }
}

const lower = (values: readonly string[] | undefined) => new Set((values ?? []).map((value) => value.toLowerCase()))

/** Whether one routine's GitHub filters accept this event. */
export function githubFilterMatches(config: GitHubConfig, event: GitHubEventKey, payload: GitHubPayload): boolean {
  if (!config.events.includes(event)) {
    return false
  }
  const item = payload.pull_request ?? payload.issue
  if (!item) {
    return false
  }
  const labels = lower(config.labels)
  if (labels.size > 0) {
    if (payload.action === 'labeled') {
      // A labeled event fires for the label that was just added, not for ones already there.
      if (!labels.has((payload.label?.name ?? '').toLowerCase())) {
        return false
      }
    } else if (!(item.labels ?? []).some((label) => labels.has((label.name ?? '').toLowerCase()))) {
      return false
    }
  }
  const authors = lower(config.authors)
  if (authors.size > 0) {
    const actor = event === 'issue_comment.created' ? payload.comment?.user?.login : item.user?.login
    if (!authors.has((actor ?? '').toLowerCase())) {
      return false
    }
  }
  const bases = new Set(config.baseBranches ?? [])
  if (bases.size > 0 && !bases.has(payload.pull_request?.base?.ref ?? '')) {
    // Base-branch filters only ever match pull_request events (issues have no base).
    return false
  }
  return true
}

const clip = (value: string | null | undefined) => (value ?? '').slice(0, CONTEXT_TEXT_CHARS)

/** What the run needs from the delivery: where to post, what to check out, and a bounded context digest. */
export function githubRunDetail(event: GitHubEventKey, payload: GitHubPayload, delivery: string): RunDetail {
  const repo = payload.repository?.full_name ?? ''
  const item = (payload.pull_request ?? payload.issue)!
  const isPullRequest = Boolean(payload.pull_request) || Boolean(payload.issue?.pull_request)
  const sameRepoHead = payload.pull_request?.head?.repo?.full_name?.toLowerCase() === repo.toLowerCase() ? payload.pull_request?.head?.ref : undefined
  return {
    event,
    delivery,
    target: { repo, number: item.number ?? 0, kind: isPullRequest ? 'pull_request' : 'issue', ...(item.html_url ? { url: item.html_url } : {}) },
    ...(sameRepoHead ? { checkoutRef: sameRepoHead } : {}),
    context: {
      event,
      repository: repo,
      [isPullRequest ? 'pullRequest' : 'issue']: {
        number: item.number,
        title: clip(item.title),
        body: clip(item.body),
        author: item.user?.login,
        labels: (item.labels ?? []).map((label) => label.name),
        url: item.html_url,
        ...(payload.pull_request ? { baseBranch: payload.pull_request.base?.ref, headBranch: payload.pull_request.head?.ref } : {})
      },
      ...(payload.label?.name ? { labelAdded: payload.label.name } : {}),
      ...(payload.comment ? { comment: { author: payload.comment.user?.login, body: clip(payload.comment.body), url: payload.comment.html_url } } : {}),
      sender: payload.sender?.login
    }
  }
}

async function githubWebhook(request: Request, deps: HookDeps): Promise<Response> {
  const secret = deps.githubWebhookSecret
  if (!secret || secret.length < 20) {
    return json({ error: 'not_configured' }, 503)
  }
  const body = await readCapped(request, MAX_GITHUB_BODY_BYTES)
  if (body === null) {
    return json({ error: 'payload_too_large' }, 413)
  }
  if (!(await verifyGitHubSignature(secret, body, request.headers.get('x-hub-signature-256')))) {
    return json({ error: 'unauthorized' }, 401)
  }
  const eventName = request.headers.get('x-github-event') ?? ''
  const delivery = request.headers.get('x-github-delivery') ?? ''
  if (eventName === 'ping') {
    return json({ ok: true })
  }
  if (!/^[A-Za-z0-9-]{8,64}$/.test(delivery)) {
    return json({ error: 'invalid_request', reason: 'delivery' }, 400)
  }
  let payload: GitHubPayload
  try {
    payload = JSON.parse(body) as GitHubPayload
  } catch {
    return json({ error: 'invalid_json' }, 400)
  }
  const event = `${eventName}.${payload.action ?? ''}` as GitHubEventKey
  if (!GITHUB_EVENTS.includes(event)) {
    return json({ matched: 0, ignored: 'event' }, 202)
  }
  if (payload.sender?.type === 'Bot') {
    // Includes this app's own comments and PRs: a routine never triggers itself.
    return json({ matched: 0, ignored: 'bot_sender' }, 202)
  }
  const installationId = payload.installation?.id
  const repo = payload.repository?.full_name?.toLowerCase()
  if (!installationId || !repo) {
    return json({ matched: 0, ignored: 'no_installation' }, 202)
  }
  // Only accounts bound to this installation (and not revoked) can be triggered by it.
  const { results } = await deps.db
    .prepare(
      `SELECT r.*, p.repo_url AS repo_url, p.default_ref AS default_ref, NULL AS last_run_id, NULL AS last_run_status, NULL AS last_run_finished_at
       FROM routines r JOIN projects p ON p.id = r.project_id
       WHERE r.trigger_kind = 'github' AND r.enabled = 1 AND r.deleted_at IS NULL
         AND r.account_id IN (SELECT account_id FROM github_installations WHERE installation_id = ? AND revoked_at IS NULL)
       LIMIT 200`
    )
    .bind(installationId)
    .all<RoutineRecord>()
  const now = deps.now()
  const runIds: string[] = []
  for (const routine of results) {
    const parsed = routine.repo_url ? parseGitHubRepo(routine.repo_url) : null
    const config = triggerConfig(routine)
    if (!parsed || `${parsed.owner}/${parsed.repo}`.toLowerCase() !== repo || config.kind !== 'github' || !githubFilterMatches(config, event, payload)) {
      continue
    }
    try {
      const run = await enqueueRun(deps.db, routine, { trigger: 'github', detail: githubRunDetail(event, payload, delivery), dedupeKey: `github:${delivery}:${routine.id}` }, now)
      runIds.push(run.id)
    } catch (error) {
      if (!(error instanceof RunRefusedError)) {
        throw error
      }
      // Redelivery (duplicate) or a full queue: nothing new to run.
    }
  }
  console.log(JSON.stringify({ event: 'github_webhook', githubEvent: event, matched: runIds.length }))
  return json({ matched: runIds.length, runIds }, 202)
}
