import { createAdaptorServer } from '@hono/node-server'
import {
  PUSH_LIMITS,
  PushDeviceRegistrationRequestSchema,
  PushHostChallengeRequestSchema,
  PushHostSessionRequestSchema,
  PushSendRequestSchema,
  type PushSendResult
} from '@orca-cloud/push-contract'
import { Hono, type MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { ApnsClient } from './apns-client.js'
import { createApnsHttp2Transport, type ApnsTransport } from './apns-http2-transport.js'
import { clientIpRateLimit, ClientIpRateLimiter } from './client-ip-rate-limit.js'
import { PushCoalescer } from './coalescer.js'
import type { PushConfig } from './config.js'
import { PushDeviceRegistryStore } from './device-registry-store.js'
import { createFcmAccessTokenProvider } from './fcm-access-token.js'
import { createFcmFetchTransport, FcmClient, type FcmTransport } from './fcm-client.js'
import { PushHostChallengeStore } from './host-challenge-store.js'
import { PushHostSessionStore } from './host-session-store.js'
import type { PushDatabase } from './push-database.js'
import { PushDispatcher } from './push-dispatcher.js'
import { PushObservability } from './push-observability.js'
import { createPushReadiness } from './push-readiness.js'
import { PushSendQuota } from './send-quota.js'

export type PushServerOptions = {
  now?: () => number
  apnsTransport?: ApnsTransport
  fcmTransport?: FcmTransport
  fcmAccessToken?: () => Promise<string>
  setTimer?: PushCoalescerTimerFactory
  clearTimer?: (timer: { readonly handle: unknown }) => void
}

type PushCoalescerTimerFactory = (
  callback: () => void,
  delayMs: number
) => { readonly handle: unknown }

type PushVariables = { hostFingerprint: string }

export function readBearer(header: string | undefined): string | null {
  if (!header) return null
  const [scheme, ...rest] = header.split(' ')
  const token = rest.join(' ').trim()
  return scheme?.toLowerCase() === 'bearer' && token.length > 0 ? token : null
}

// Hono's body limit, not a Content-Length check: a chunked body declares no
// length, and req.json() would buffer all of it before any handler ran.
const limitBody = bodyLimit({
  maxSize: PUSH_LIMITS.maxHttpBodyBytes,
  onError: (context) => context.json({ error: 'request_too_large' }, 413)
})

export function createPushServer(
  config: PushConfig,
  database: PushDatabase,
  options: PushServerOptions = {}
) {
  const now = options.now ?? Date.now
  const observability = new PushObservability()
  const challenges = new PushHostChallengeStore(database, config.publicUrl, now)
  const sessions = new PushHostSessionStore(database, now)
  const devices = new PushDeviceRegistryStore(database, now)
  const quota = new PushSendQuota(database, now)
  const apnsTransport = options.apnsTransport ?? (config.apns ? createApnsHttp2Transport() : null)
  const dispatcher = new PushDispatcher({
    devices,
    ...(config.apns && apnsTransport
      ? {
          apns: new ApnsClient({
            topic: config.apnsTopic,
            credentials: config.apns,
            transport: apnsTransport,
            now
          })
        }
      : {}),
    fcm: new FcmClient({
      projectId: config.fcmProjectId,
      accessToken: options.fcmAccessToken ?? createFcmAccessTokenProvider(),
      transport: options.fcmTransport ?? createFcmFetchTransport()
    }),
    onOutcome: (status) =>
      observability.record(
        status === 'sent' ? 'delivery_sent' : status === 'dead' ? 'delivery_dead' : 'delivery_error'
      )
  })
  const coalescer = new PushCoalescer({
    windowMs: config.coalesceMs,
    deliver: (delivery) => dispatcher.deliver(delivery),
    ...(options.setTimer ? { setTimer: options.setTimer } : {}),
    ...(options.clearTimer ? { clearTimer: options.clearTimer } : {}),
    onDeliveryFailed: () => observability.record('delivery_error')
  })
  const ready = createPushReadiness(database, { now })
  const unauthenticatedIps = new ClientIpRateLimiter({ now })
  const limitUnauthenticatedIp = clientIpRateLimit(unauthenticatedIps, {
    trustedProxyHops: config.trustedProxyHops,
    onLimited: () => observability.record('ip_rate_limited')
  })
  // Why a second bucket: a bearer has to be looked up before it can be refused,
  // and that lookup takes one of very few pool connections. Capping the caller
  // first keeps a flood of forged bearers from starving real hosts of the pool.
  const authenticatedIps = new ClientIpRateLimiter({
    now,
    capacity: PUSH_LIMITS.authenticatedRequestsPerMinutePerIp
  })
  const limitAuthenticatedIp = clientIpRateLimit(authenticatedIps, {
    trustedProxyHops: config.trustedProxyHops,
    onLimited: () => observability.record('ip_rate_limited')
  })
  const app = new Hono<{ Variables: PushVariables }>()
  // Hono's default handler prints the whole error, and a pg error carries the
  // offending row in `detail`. Only the error's name may reach the logs.
  app.onError((error, context) => {
    observability.record('request_error')
    console.warn(
      JSON.stringify({
        event: 'orca_push_request_failed',
        error: error instanceof Error ? error.name : 'unknown'
      })
    )
    return context.json({ error: 'internal' }, 500)
  })

  app.get('/health', (context) => context.json({ ok: true, pushProtocol: 1 }))
  app.get('/ready', async (context) =>
    (await ready()) ? context.json({ ok: true }) : context.json({ error: 'dependency_unavailable' }, 503)
  )

  const bearerSession: MiddlewareHandler<{ Variables: PushVariables }> = async (context, next) => {
    const bearer = readBearer(context.req.header('authorization'))
    if (!bearer) return context.json({ error: 'invalid_token' }, 401)
    const session = await sessions.resolve(bearer)
    if (!session.ok) {
      return context.json(
        { error: session.reason === 'session_expired' ? 'session_expired' : 'invalid_token' },
        401
      )
    }
    context.set('hostFingerprint', session.hostFingerprint)
    await next()
    return
  }
  // `/v1/devices/*` matches `/v1/devices` itself; a second registration for the
  // bare path would run both middlewares twice on it.
  app.use('/v1/devices/*', limitAuthenticatedIp, bearerSession)
  app.use('/v1/send', limitAuthenticatedIp, bearerSession)

  app.post('/v1/host/challenge', limitUnauthenticatedIp, limitBody, async (context) => {
    const body = PushHostChallengeRequestSchema.safeParse(
      await context.req.json().catch(() => null)
    )
    if (!body.success) return context.json({ error: 'invalid_request' }, 400)
    const issued = await challenges.issue(body.data.hostPublicKeyB64)
    if (!issued) {
      observability.record('challenge_rejected')
      return context.json({ error: 'invalid_request' }, 400)
    }
    observability.record('challenge_issued')
    const { hostFingerprint: _bound, ...response } = issued
    return context.json(response)
  })

  app.post('/v1/host/session', limitUnauthenticatedIp, limitBody, async (context) => {
    const body = PushHostSessionRequestSchema.safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid_request' }, 400)
    const verification = await challenges.verify(body.data.challengeId, body.data.proofB64)
    if (!verification.ok) {
      observability.record('session_rejected')
      return context.json(
        { error: verification.reason === 'unknown_challenge' ? 'invalid_challenge' : 'invalid_proof' },
        401
      )
    }
    observability.record('session_issued')
    return context.json(await sessions.create(verification.hostFingerprint))
  })

  app.post('/v1/devices', limitBody, async (context) => {
    const body = PushDeviceRegistrationRequestSchema.safeParse(
      await context.req.json().catch(() => null)
    )
    if (!body.success) return context.json({ error: 'invalid_request' }, 400)
    const registered = await devices.upsert({
      hostFingerprint: context.get('hostFingerprint'),
      deviceId: body.data.deviceId,
      platform: body.data.platform,
      token: body.data.token,
      ...(body.data.apnsEnvironment === undefined
        ? {}
        : { apnsEnvironment: body.data.apnsEnvironment }),
      filter: body.data.filter
    })
    if (!registered.ok) {
      observability.record('device_rejected')
      return context.json({ error: 'too_many_devices' }, 409)
    }
    observability.record('device_registered')
    return context.json({ registrationId: registered.registrationId })
  })

  app.delete('/v1/devices/:registrationId', async (context) => {
    const deleted = await devices.deleteOwned(
      context.get('hostFingerprint'),
      context.req.param('registrationId')
    )
    if (!deleted) return context.json({ error: 'not_found' }, 404)
    observability.record('device_deleted')
    return context.body(null, 204)
  })

  app.get('/v1/devices', async (context) =>
    context.json({ devices: await devices.list(context.get('hostFingerprint')) })
  )

  app.post('/v1/send', limitBody, async (context) => {
    const body = PushSendRequestSchema.safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid_request' }, 400)
    const hostFingerprint = context.get('hostFingerprint')
    const owned = await devices.findOwned(hostFingerprint, body.data.registrationIds)
    const results: PushSendResult[] = []
    for (const registrationId of body.data.registrationIds) {
      const device = owned.get(registrationId)
      if (!device) {
        observability.record('send_error')
        results.push({ registrationId, status: 'error' })
        continue
      }
      if (device.dead) {
        observability.record('send_dead')
        results.push({ registrationId, status: 'dead' })
        continue
      }
      if ((await quota.reserve(hostFingerprint, registrationId)) === 'rate_limited') {
        observability.record('send_rate_limited')
        results.push({ registrationId, status: 'rate_limited' })
        continue
      }
      coalescer.enqueue({ registrationId, hostFingerprint, notification: body.data.notification })
      observability.record('send_queued')
      results.push({ registrationId, status: 'queued' })
    }
    return context.json({ results })
  })

  return {
    app,
    server: createAdaptorServer(app),
    challenges,
    sessions,
    devices,
    quota,
    unauthenticatedIps,
    coalescer,
    observability,
    ready,
    closeTransports: (): void => {
      if (apnsTransport && 'close' in apnsTransport) {
        (apnsTransport as { close: () => void }).close()
      }
    }
  }
}
