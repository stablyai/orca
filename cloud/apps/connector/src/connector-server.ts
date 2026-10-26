import { createAdaptorServer } from '@hono/node-server'
import type { CloudDatabase, CloudNotifications } from '@orca-cloud/cloud-database'
import { CONNECTOR_LIMITS } from '@orca-cloud/connector-contract'
import type { JWTVerifyGetKey } from 'jose'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { ConnectorConfig } from './config.js'
import { ConnectorHosts } from './connector-hosts.js'
import { ConnectorInbox } from './connector-inbox.js'
import { ConnectorThreads } from './connector-threads.js'
import { createConnectorTokenVerifier } from './connector-token-verifier.js'
import { registerDevEnqueueRoute } from './dev-enqueue-route.js'
import { InboxWaker } from './inbox-waker.js'
import { machineAuth, type MachineEnv } from './machine-auth.js'
import { registerMachineRoutes } from './machine-routes.js'
import { queueDelivery } from './queue-delivery.js'
import { limitByClientIp, RateLimiter } from './rate-limiter.js'
import { RequestDrain } from './request-drain.js'

const MAX_BODY_BYTES = 64 * 1024
const UNAUTHENTICATED_PER_MINUTE_PER_IP = 30
const AUTHENTICATED_PER_MINUTE_PER_IP = 6_000
const AUTHENTICATED_PER_MINUTE_PER_HOST = 600

export type ConnectorServerOptions = {
  now?: () => number
  // The auth service's signing keys; tests pass a local set.
  jwks?: JWTVerifyGetKey
  pollHoldMs?: number
}

function isLoopbackOrigin(origin: string): boolean {
  return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname)
}

// Local development listens on its loopback origin only, so the unauthenticated dev route can't be
// reached from another machine; anything else listens on every interface, as Cloud Run needs.
export function listenHostname(publicUrl: string): string | undefined {
  return isLoopbackOrigin(publicUrl) ? new URL(publicUrl).hostname.replace(/^\[|\]$/g, '') : undefined
}

export function createConnectorServer(
  config: ConnectorConfig,
  database: CloudDatabase,
  notifications: CloudNotifications,
  options: ConnectorServerOptions = {}
) {
  const now = options.now ?? Date.now
  const inbox = new ConnectorInbox(database, notifications, now)
  const hosts = new ConnectorHosts(database, inbox, now)
  const threads = new ConnectorThreads(now)
  const waker = new InboxWaker(notifications)
  const queue = (input: Parameters<typeof queueDelivery>[1]) =>
    queueDelivery({ database, inbox, threads, hosts }, input)
  const limitUnauthenticated = limitByClientIp(
    new RateLimiter(UNAUTHENTICATED_PER_MINUTE_PER_IP, now),
    config.trustedProxyHops
  )
  const limitAuthenticated = limitByClientIp(
    new RateLimiter(AUTHENTICATED_PER_MINUTE_PER_IP, now),
    config.trustedProxyHops
  )
  const limitBody = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (context) => context.json({ error: 'request_too_large' }, 413)
  })

  const app = new Hono<MachineEnv>()
  const requestDrain = new RequestDrain()
  app.use('*', requestDrain.middleware)
  // Default logging can carry row detail; log only the error's name.
  app.onError((error, context) => {
    console.warn(
      JSON.stringify({
        event: 'orca_connector_request_failed',
        error: error instanceof Error ? error.name : 'unknown'
      })
    )
    return context.json({ error: 'internal' }, 500)
  })

  app.get('/health', (context) => context.json({ ok: true, mode: config.mode }))
  app.get('/ready', limitUnauthenticated, async (context) =>
    (await database.query('SELECT 1 AS ready').then(
      () => true,
      () => false
    ))
      ? context.json({ ok: true })
      : context.json({ error: 'dependency_unavailable' }, 503)
  )

  if (config.mode === 'validation') {
    app.use('*', async (context) => context.json({ error: 'validation_only' }, 503))
  }

  app.use(
    '/v1/connector/*',
    limitAuthenticated,
    machineAuth({
      verifyToken: createConnectorTokenVerifier(config, options.jwks),
      hostRequests: new RateLimiter(AUTHENTICATED_PER_MINUTE_PER_HOST, now)
    })
  )
  registerMachineRoutes(app, {
    database,
    inbox,
    threads,
    hosts,
    waker,
    now,
    holdMs: options.pollHoldMs ?? CONNECTOR_LIMITS.initialPollHoldMs,
    limitBody
  })
  // Local development only: a stand-in for Slack ingress until it exists.
  if (isLoopbackOrigin(config.publicUrl)) {
    registerDevEnqueueRoute(app, { queue, limitBody })
  }

  return {
    app,
    requestDrain,
    server: createAdaptorServer(app),
    inbox,
    waker,
    queueDelivery: queue
  }
}
