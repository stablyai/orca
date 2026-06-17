import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import type {
  Automation,
  AutomationWebhookDelivery,
  WebhookServerEndpoint
} from '../../shared/automations-types'
import type { WebhookServerSettings } from '../../shared/types'
import { captureWebhookDelivery, isWebhookTriggerEnabled } from '../../shared/automation-webhook'
import { verifyWebhookSecret } from './webhook-secret'
import { WebhookRateLimiter } from './webhook-rate-limiter'

/** Hard cap on the request body we will read into memory. The stored delivery
 *  is truncated further (MAX_WEBHOOK_BODY_CHARS); this just bounds memory for a
 *  single inbound request. */
const MAX_REQUEST_BYTES = 1024 * 1024

/** Bound request time so a slow/stalled client cannot hold a socket open
 *  indefinitely (slowloris-style). */
const REQUEST_SLOWLORIS_MS = 10_000

const WEBHOOK_PATH_PREFIX = '/webhook/'

export type WebhookServerDeps = {
  /** Resolve an automation by id (used to find the matching webhook config). */
  getAutomation: (automationId: string) => Automation | undefined
  /** Trigger a webhook run. The server has already verified the secret. */
  triggerWebhook: (
    automationId: string,
    delivery: AutomationWebhookDelivery
  ) => Promise<unknown> | unknown
}

function readBodyWithLimit(req: IncomingMessage): Promise<{ body: string; tooLarge: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false
    req.on('data', (chunk: Buffer) => {
      if (settled) {
        return
      }
      total += chunk.length
      if (total > MAX_REQUEST_BYTES) {
        // Why: stop reading immediately and drop the socket rather than waiting
        // for the rest of an oversized body to arrive.
        settled = true
        req.destroy()
        resolve({ body: '', tooLarge: true })
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!settled) {
        settled = true
        resolve({ body: Buffer.concat(chunks).toString('utf8'), tooLarge: false })
      }
    })
    req.on('error', (err) => {
      if (!settled) {
        settled = true
        reject(err)
      }
    })
  })
}

function parseAutomationId(rawUrl: string | undefined): string | null {
  const pathname = new URL(rawUrl ?? '/', 'http://127.0.0.1').pathname
  if (!pathname.startsWith(WEBHOOK_PATH_PREFIX)) {
    return null
  }
  const rest = pathname.slice(WEBHOOK_PATH_PREFIX.length)
  // Why: accept exactly one path segment — `/webhook/<id>`, no trailing
  // sub-paths — so the route surface stays minimal and unambiguous.
  if (rest.length === 0 || rest.includes('/')) {
    return null
  }
  return decodeURIComponent(rest)
}

/** Loopback/LAN HTTP listener that lets external events (e.g. GitLab MR hooks)
 *  trigger automations. Generic by design: any JSON/text body is accepted and
 *  forwarded verbatim; the only provider-aware step is optional secret
 *  verification. Modeled on the agent-hooks server, but the bind interface is
 *  configurable (issue #2) so a self-hosted Git server can reach it. */
export class WebhookServer {
  private readonly deps: WebhookServerDeps
  private readonly rateLimiter: WebhookRateLimiter
  private server: Server | null = null
  private bindAddress = '127.0.0.1'
  private port = 0
  private lastError: string | null = null

  constructor(deps: WebhookServerDeps, rateLimiter: WebhookRateLimiter = new WebhookRateLimiter()) {
    this.deps = deps
    this.rateLimiter = rateLimiter
  }

  getEndpoint(): WebhookServerEndpoint {
    return {
      running: this.server !== null,
      bindAddress: this.bindAddress,
      port: this.port,
      error: this.lastError
    }
  }

  /** Apply a settings snapshot: start, stop, or rebind as needed. Safe to call
   *  on every settings change — a no-op when nothing relevant changed. */
  async apply(settings: WebhookServerSettings): Promise<void> {
    if (!settings.enabled) {
      this.stop()
      return
    }
    if (
      this.server &&
      this.bindAddress === settings.bindAddress &&
      this.port === settings.port &&
      this.lastError === null
    ) {
      return
    }
    this.stop()
    await this.start(settings)
  }

  async start(settings: WebhookServerSettings): Promise<void> {
    if (this.server) {
      return
    }
    this.lastError = null
    this.bindAddress = settings.bindAddress
    const server = createServer((req, res) => {
      void this.handleRequest(req, res)
    })
    this.server = server
    await new Promise<void>((resolve) => {
      const onError = (err: Error): void => {
        // Why: a bind failure (EADDRINUSE, EACCES) must not crash main. Record
        // it for the UI and resolve so startup continues; the listener stays
        // down until the user fixes the config.
        this.lastError = err.message
        this.server = null
        server.off('listening', onListening)
        resolve()
      }
      const onListening = (): void => {
        server.off('error', onError)
        server.on('error', (err) => {
          this.lastError = err.message
        })
        const address = server.address()
        if (address && typeof address === 'object') {
          this.port = address.port
        }
        resolve()
      }
      server.once('error', onError)
      server.listen(settings.port, settings.bindAddress, onListening)
    })
  }

  stop(): void {
    if (!this.server) {
      return
    }
    // Why: drop keep-alive sockets so the port frees immediately for a rebind
    // (apply() stop→start on a port/interface change) instead of lingering.
    this.server.closeAllConnections?.()
    this.server.close()
    this.server = null
    this.port = 0
    this.rateLimiter.prune()
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (req.method !== 'POST') {
        res.writeHead(405)
        res.end()
        return
      }
      const automationId = parseAutomationId(req.url)
      if (!automationId) {
        res.writeHead(404)
        res.end()
        return
      }
      // Why: cap how often a single source can trigger runs before doing any
      // expensive work — matters most on a LAN/0.0.0.0 bind.
      const remoteKey = req.socket.remoteAddress ?? 'unknown'
      if (!this.rateLimiter.tryAcquire(remoteKey)) {
        res.writeHead(429)
        res.end()
        return
      }

      const automation = this.deps.getAutomation(automationId)
      // Why: return 404 for both "no such automation" and "webhook disabled"
      // so an attacker cannot enumerate which ids exist.
      if (!automation || !isWebhookTriggerEnabled(automation) || !automation.webhook) {
        res.writeHead(404)
        res.end()
        return
      }

      req.setTimeout(REQUEST_SLOWLORIS_MS, () => req.destroy())
      const { body, tooLarge } = await readBodyWithLimit(req)
      if (tooLarge) {
        res.writeHead(413)
        res.end()
        return
      }

      const verification = verifyWebhookSecret({
        config: automation.webhook,
        headers: req.headers,
        rawBody: body
      })
      if (!verification.ok) {
        res.writeHead(401)
        res.end()
        return
      }

      const contentType =
        typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : null
      const delivery = captureWebhookDelivery({ body, contentType, receivedAt: Date.now() })
      await this.deps.triggerWebhook(automationId, delivery)

      res.writeHead(202)
      res.end()
    } catch (err) {
      console.error('[webhooks] request handling failed', err)
      if (!res.headersSent) {
        res.writeHead(500)
      }
      res.end()
    }
  }
}
