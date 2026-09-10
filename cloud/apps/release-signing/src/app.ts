import { createHmac, timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import type { SigningConfig } from './config.js'
import { SigningGates } from './signing-gates.js'

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

function equalSecret(actual: string, expected: string): boolean {
  const a = Buffer.from(actual),
    b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}
export function createApp(config: SigningConfig, gates: SigningGates) {
  const app = new Hono()
  app.use('*', bodyLimit({ maxSize: 256 * 1024 }))
  app.onError((error, c) => {
    if (error instanceof HTTPException && error.status === 413)
      return c.json({ error: 'Request body too large' }, 413)
    console.error(
      'Signing gate request failed',
      error instanceof Error ? error.message : 'Unknown error'
    )
    return c.json({ error: 'Signing gate could not be verified' }, 503)
  })
  app.get('/health', (c) => c.json({ ok: true }))
  app.get('/ready', async (c) => {
    await gates.checkConfiguration()
    return c.json({
      appId: config.appId,
      repository: config.repository,
      environments: config.policies.flatMap((p) => Object.values(p.environments))
    })
  })
  app.post('/webhooks/github', async (c) => {
    const raw = await c.req.text()
    const signature = `sha256=${createHmac('sha256', config.githubWebhookSecret).update(raw).digest('hex')}`
    if (!equalSecret(c.req.header('x-hub-signature-256') ?? '', signature))
      return c.json({ error: 'Unauthorized' }, 401)
    if (c.req.header('x-github-event') === 'ping') return c.json({ ok: true })
    if (c.req.header('x-github-event') !== 'deployment_protection_rule')
      return c.json({ error: 'Unsupported event' }, 400)
    const parsed = z
      .object({
        action: z.literal('requested'),
        environment: z.string(),
        deployment_callback_url: z.string(),
        repository: z.object({ full_name: z.literal(config.repository) }),
        installation: z.object({ id: z.literal(config.installationId) })
      })
      .safeParse(parseJson(raw))
    if (!parsed.success) return c.json({ error: 'Invalid protection event' }, 400)
    const prefix = `https://api.github.com/repos/${config.repository}/actions/runs/`
    const value = parsed.data.deployment_callback_url
    const match = value.startsWith(prefix)
      ? /^(\d+)\/deployment_protection_rule$/.exec(value.slice(prefix.length))
      : null
    const runId = Number(match?.[1])
    if (!Number.isSafeInteger(runId) || runId <= 0)
      return c.json({ error: 'Invalid callback scope' }, 400)
    await gates.processRun(runId, parsed.data.environment)
    return c.json({ ok: true })
  })
  app.post('/webhooks/signpath', async (c) => {
    if (
      !equalSecret(
        c.req.header('authorization') ?? c.req.header('authentication') ?? '',
        `Bearer ${config.signpathWebhookSecret}`
      )
    )
      return c.json({ error: 'Unauthorized' }, 401)
    const parsed = z
      .object({
        OrganizationId: z.literal(config.signpathOrganization),
        SigningRequestId: z.string().uuid(),
        Status: z.enum(['Completed', 'Failed', 'Denied', 'Canceled'])
      })
      .safeParse(parseJson(await c.req.text()))
    if (!parsed.success) return c.json({ error: 'Invalid signing event' }, 400)
    await gates.processSignpath(parsed.data.SigningRequestId)
    return c.json({ ok: true })
  })
  app.post('/reconcile', async (c) => {
    if (!equalSecret(c.req.header('authorization') ?? '', `Bearer ${config.reconcileSecret}`))
      return c.json({ error: 'Unauthorized' }, 401)
    await gates.reconcile()
    return c.json({ ok: true })
  })
  return app
}
