import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { z } from 'zod'
import { DashboardSnapshotCache } from './dashboard-snapshot.js'
import { createGcloudClient } from './gcloud-client.js'
import {
  dispatchStagingPowerWorkflow,
  parseStagingPowerRequest
} from './staging-workflow.js'

const QuerySchema = z.object({
  environment: z.enum(['production', 'staging']).default('production'),
  window: z.coerce.number().int().min(30).max(1440).default(360)
})
const port = z.coerce.number().int().min(1024).max(65_535).parse(process.env.PORT ?? 2455)
const controlsEnabled = process.env.RELAY_OPS_ENABLE_STAGING_CONTROLS === '1'
const csrfToken = randomBytes(32).toString('base64url')
const publicDirectory = resolve(import.meta.dirname, '../public')
const cache = new DashboardSnapshotCache(createGcloudClient())
const app = new Hono()

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

app.use('*', async (context, next) => {
  await next()
  context.header('Cache-Control', 'no-store')
  context.header('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "font-src 'self'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'"
  ].join('; '))
  context.header('Referrer-Policy', 'no-referrer')
  context.header('X-Content-Type-Options', 'nosniff')
  context.header('X-Frame-Options', 'DENY')
})

app.get('/health', (context) => context.json({ status: 'ok' }))
app.get('/api/config', (context) => context.json({
  stagingControlsEnabled: controlsEnabled,
  csrfToken: controlsEnabled ? csrfToken : null
}))
app.get('/api/snapshot', async (context) => {
  const query = QuerySchema.safeParse(context.req.query())
  if (!query.success) return context.json({ error: 'Invalid dashboard query' }, 400)
  try {
    return context.json(await cache.read(query.data.environment, query.data.window))
  } catch {
    return context.json({
      error: 'Relay operations data is unavailable. Check local gcloud and gh authentication.'
    }, 503)
  }
})
app.post('/api/staging/power', async (context) => {
  if (!controlsEnabled) return context.json({ error: 'Staging controls are disabled' }, 403)
  const origin = context.req.header('origin')
  const expectedOrigin = `http://127.0.0.1:${port}`
  if (origin !== expectedOrigin) return context.json({ error: 'Origin rejected' }, 403)
  if (!safeEqual(context.req.header('x-csrf-token') ?? '', csrfToken)) {
    return context.json({ error: 'Request token rejected' }, 403)
  }
  try {
    const request = parseStagingPowerRequest(await context.req.json())
    await dispatchStagingPowerWorkflow(request)
    return context.json({ accepted: true })
  } catch {
    return context.json({ error: 'Invalid or failed staging workflow dispatch' }, 400)
  }
})

const staticTypes: Record<string, string> = {
  '/app.js': 'text/javascript; charset=utf-8',
  '/styles.css': 'text/css; charset=utf-8'
}
for (const [route, contentType] of Object.entries(staticTypes)) {
  app.get(route, async (context) => {
    const file = route.slice(1)
    try {
      const content = await readFile(resolve(publicDirectory, file))
      return context.body(content, 200, { 'Content-Type': contentType })
    } catch {
      return context.notFound()
    }
  })
}
app.get('/', async (context) => {
  const html = await readFile(resolve(publicDirectory, 'index.html'), 'utf8')
  return context.html(html)
})

serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, () => {
  // Loopback is intentional; operators may add authenticated Tailscale Serve separately.
  console.log(`Orca Relay Operations: http://127.0.0.1:${port}`)
  console.log(`Staging controls: ${controlsEnabled ? 'enabled through GitHub workflow' : 'read-only'}`)
})
