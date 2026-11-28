// The local webhook listener: POST <base>/hooks/<hookId>[/<key>], or the key as a Bearer token.
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  matchesWebhookCall,
  webhookBodyFits,
  webhookCallSubject
} from '../../../../cloud/packages/connector-contract/src/webhook-matcher'
import { WEBHOOK_HOOK_ID_PATTERN } from '../../../shared/connector-webhook-contract'
import type { WebhookEnvelope } from '../../../shared/connector-webhook-routes'
import { webhookCallView } from '../webhook-call-file'
import {
  deliverLocalCall,
  hookAutomation,
  parseWebhookBody,
  withoutKeys,
  type LocalWebhookDeliverDeps
} from './local-webhook-delivery'
import type { LocalCall, LocalHook } from './local-webhook-store'

// As Orca Cloud's WEBHOOK_ENVELOPE_LIMITS (connector-contract/src/webhook-envelope.ts).
const MAX_HEADER_VALUE_LENGTH = 1024

export const LOCAL_WEBHOOK_LIMITS: {
  maxBodyBytes: number
  perHookPerMinute: number
  perMinute: number
} = { maxBodyBytes: 1024 * 1024, perHookPerMinute: 30, perMinute: 120 }

// Only these headers are kept with a call; Authorization, cookies and signatures never are.
const KEPT_HEADERS = [
  'content-type',
  'user-agent',
  'x-github-event',
  'x-github-delivery',
  'x-github-hook-id',
  'idempotency-key',
  'x-request-id'
]
// A sender's own delivery id: a repeat of one is dropped for a day.
const DELIVERY_ID_HEADERS = ['x-github-delivery', 'idempotency-key']

const TOO_LARGE_CLOSE_MS = 2000

const PATH = /^\/hooks\/([^/]+)(?:\/([^/]+))?\/?$/

/** Requests per minute, counted per key in fixed one-minute windows. */
class MinuteCounts {
  private readonly windows = new Map<string, { start: number; count: number }>()
  take(key: string, limit: number, now: number): boolean {
    const start = Math.floor(now / 60_000) * 60_000
    const window = this.windows.get(key)
    if (!window || window.start !== start) {
      this.windows.set(key, { start, count: 1 })
      return true
    }
    window.count++
    return window.count <= limit
  }
}

function send(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {}
): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    ...headers
  })
  res.end(JSON.stringify(body))
}

/** The body, or 'too_large' as soon as it passes the cap; nothing past the cap is kept. */
function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer | 'too_large'> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    req.on('data', (chunk: Buffer) => {
      if (done) {
        return
      }
      size += chunk.length
      if (size > maxBytes) {
        done = true
        resolve('too_large')
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!done) {
        done = true
        resolve(Buffer.concat(chunks))
      }
    })
    req.on('error', (error) => {
      if (!done) {
        done = true
        reject(error)
      }
    })
  })
}

function bearerKey(req: IncomingMessage): string | null {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? '')
  return match?.[1] ?? null
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return typeof value === 'string' ? value.slice(0, MAX_HEADER_VALUE_LENGTH) : undefined
}

/** The path's hook id and key, or null for any other path. */
function hookPath(url: string | undefined): { hookId: string; key: string | null } | null {
  const match = PATH.exec(new URL(url ?? '/', 'http://local').pathname)
  if (!match) {
    return null
  }
  try {
    const key = match[2] === undefined ? null : decodeURIComponent(match[2])
    return { hookId: match[1] ?? '', key }
  } catch {
    return null
  }
}

export type LocalWebhookHandlerDeps = LocalWebhookDeliverDeps & {
  now?: () => number
  limits?: Partial<typeof LOCAL_WEBHOOK_LIMITS>
}

export function createLocalWebhookHandler(
  deps: LocalWebhookHandlerDeps
): (req: IncomingMessage, res: ServerResponse) => void {
  const now = deps.now ?? Date.now
  const limits = { ...LOCAL_WEBHOOK_LIMITS, ...deps.limits }
  const counts = new MinuteCounts()
  // Requests now being taken, by hook and sender delivery id.
  const admitting = new Map<string, Promise<void>>()
  const notFound = (res: ServerResponse) => send(res, 404, { error: 'not_found' })
  const rateLimited = (res: ServerResponse) =>
    send(res, 429, { error: 'rate_limited' }, { 'retry-after': '60' })

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = hookPath(req.url)
    if (!path) {
      notFound(res)
      return
    }
    if (req.method !== 'POST') {
      send(res, 405, { error: 'method_not_allowed' }, { allow: 'POST' })
      return
    }
    if (!counts.take('*', limits.perMinute, now())) {
      rateLimited(res)
      return
    }
    const key = path.key ?? bearerKey(req)
    if (!key) {
      send(res, 401, { error: 'key_required' }, { 'www-authenticate': 'Bearer' })
      return
    }
    const hook = WEBHOOK_HOOK_ID_PATTERN.test(path.hookId)
      ? await deps.store.authenticate(path.hookId, key)
      : null
    if (!hook) {
      if (await deps.store.hook(path.hookId)) {
        await deps.store.count(path.hookId, 'refused')
      }
      notFound(res)
      return
    }
    if (!counts.take(hook.hookId, limits.perHookPerMinute, now())) {
      await deps.store.count(hook.hookId, 'over_budget')
      rateLimited(res)
      return
    }
    const tooLarge = () => {
      req.resume()
      // No "connection: close": Node would then end the socket at once, under a sender still uploading.
      res.writeHead(413, { 'content-type': 'application/json' })
      // The rest of the body is read and dropped briefly, so a sender still uploading gets the
      // answer, then the connection closes.
      res.end(JSON.stringify({ error: 'body_too_large' }), () => {
        setTimeout(() => req.destroy(), TOO_LARGE_CLOSE_MS).unref()
      })
    }
    if (Number(req.headers['content-length'] ?? 0) > limits.maxBodyBytes) {
      tooLarge()
      return
    }
    const raw = await readBody(req, limits.maxBodyBytes)
    if (raw === 'too_large') {
      tooLarge()
      return
    }
    const contentType = headerValue(req, 'content-type') ?? null
    const parsed = parseWebhookBody(contentType, raw.toString('utf8'))
    if (!parsed) {
      send(res, 400, { error: 'invalid_json' })
      return
    }
    if (!webhookBodyFits(parsed.value)) {
      send(res, 413, { error: 'body_too_complex' })
      return
    }
    // A stop-now rotation while the body was read ends this key too.
    if (!(await deps.store.authenticate(hook.hookId, key))) {
      notFound(res)
      return
    }
    const found = hookAutomation(deps.automations(), hook)
    if (!found) {
      notFound(res)
      return
    }
    const deliveryId = DELIVERY_ID_HEADERS.map((name) => headerValue(req, name)).find(Boolean)
    const claim = deliveryId === undefined ? null : `${hook.hookId} ${deliveryId}`
    let release = (): void => {}
    if (claim) {
      // A resend while the first is still being taken waits for it, so "duplicate" means taken.
      for (let first = admitting.get(claim); first; first = admitting.get(claim)) {
        await first
      }
      admitting.set(claim, new Promise<void>((resolve) => (release = resolve)))
    }
    let taken: Awaited<ReturnType<typeof admit>>
    try {
      if (deliveryId && (await deps.store.deliveryTaken(hook.hookId, deliveryId))) {
        await deps.store.count(hook.hookId, 'duplicate')
        send(res, 200, { status: 'duplicate' })
        return
      }
      taken = await admit(hook, found, key, deliveryId, {
        contentType,
        body: parsed,
        headers: Object.fromEntries(
          KEPT_HEADERS.flatMap((name) => {
            const value = headerValue(req, name)
            return value === undefined ? [] : [[name, value]]
          })
        )
      })
    } finally {
      if (claim) {
        admitting.delete(claim)
        release()
      }
    }
    if (!taken) {
      notFound(res)
      return
    }
    // A failed handoff leaves the call queued and retried, so the sender is answered as taken.
    if (taken.status === 'queued') {
      await deliverLocalCall(deps, hook, taken.call)
    }
    send(res, 200, { callId: taken.call.callId, status: taken.status })
  }

  /** Stores the call, with its delivery id; queued when the rule's filters take it. Null when a
   *  stop-now rotation ended the key meanwhile. */
  const admit = async (
    hook: LocalHook,
    found: NonNullable<ReturnType<typeof hookAutomation>>,
    key: string,
    deliveryId: string | undefined,
    request: Pick<WebhookEnvelope, 'contentType' | 'headers' | 'body'>
  ): Promise<{ call: LocalCall; status: 'queued' | 'ignored' | 'paused' } | null> => {
    const receivedAt = now()
    // The hook's own keys never reach the stored call, the run's file or its quote: replaced after
    // decoding, so an escaped or percent-encoded echo is caught too.
    const { contentType, headers, body } = withoutKeys(request, [hook.key, hook.previousKey, key])
    const envelope: WebhookEnvelope = { receivedAt, contentType, headers, body, truncated: false }
    const view = webhookCallView(envelope)
    const stored = async (state: 'queued' | 'ignored' | 'paused', subject?: string) => {
      const call = await deps.store.admit(
        hook,
        { receivedAt, state, ...(subject === undefined ? {} : { subject }) },
        state === 'queued' ? envelope : null,
        { key, ...(deliveryId === undefined ? {} : { deliveryId }) }
      )
      return call && { call, status: state }
    }
    if (hook.state === 'paused' || !found.automation.enabled) {
      return await stored('paused')
    }
    if (!matchesWebhookCall(found.rule, view)) {
      return await stored('ignored')
    }
    return await stored('queued', webhookCallSubject(found.rule, view))
  }

  return (req, res) => {
    handle(req, res).catch((error: unknown) => {
      console.warn('[webhooks] a local webhook call failed', error)
      if (!res.headersSent) {
        send(res, 500, { error: 'internal' })
      } else {
        res.end()
      }
    })
  }
}
