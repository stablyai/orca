import { createAdaptorServer, serve } from '@hono/node-server'
import { once } from 'node:events'
import { request } from 'node:http'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { dispatchStagingPowerWorkflow } from './staging-workflow.js'

vi.mock('@hono/node-server', async (original) => ({
  ...(await original<typeof import('@hono/node-server')>()),
  serve: vi.fn()
}))
vi.mock('./staging-workflow.js', async (original) => ({
  ...(await original<typeof import('./staging-workflow.js')>()),
  dispatchStagingPowerWorkflow: vi.fn(async () => {})
}))

beforeAll(async () => {
  vi.stubEnv('PORT', '2455')
  vi.stubEnv('RELAY_OPS_ENABLE_STAGING_CONTROLS', '1')
  await import('./index.js')
})
afterAll(() => {
  vi.unstubAllEnvs()
})

async function dashboard() {
  const options = vi.mocked(serve).mock.calls[0]?.[0]
  if (!options) throw new Error('dashboard server not configured')
  const server = createAdaptorServer(options)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing server port')
  const origin = `http://127.0.0.1:${address.port}`
  const response = await fetch(`${origin}/api/config`)
  const config: unknown = await response.json()
  if (
    !config ||
    typeof config !== 'object' ||
    !('csrfToken' in config) ||
    typeof config.csrfToken !== 'string'
  ) {
    throw new Error('missing test request token')
  }
  return {
    port: address.port,
    url: `${origin}/api/staging/power`,
    headers: {
      origin: 'http://127.0.0.1:2455',
      'content-type': 'application/json',
      'x-csrf-token': config.csrfToken
    },
    close: async () => {
      if ('closeAllConnections' in server) server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }
  }
}

it('rejects an unfinished oversized upload before dispatching a workflow', async () => {
  const test = await dashboard()
  const dispatches = vi.mocked(dispatchStagingPowerWorkflow).mock.calls.length
  const client = request({
    host: '127.0.0.1',
    port: test.port,
    path: '/api/staging/power',
    method: 'POST',
    headers: { ...test.headers, 'transfer-encoding': 'chunked' }
  })
  const result = new Promise<number | undefined>((resolve, reject) => {
    client.once('error', reject)
    client.once('response', (response) => {
      response.resume()
      response.once('end', () => resolve(response.statusCode))
      response.once('error', reject)
    })
  })
  const timeout = setTimeout(() => client.destroy(new Error('body limit did not respond')), 1000)
  try {
    client.write(' '.repeat(4097))
    expect(await result).toBe(413)
    expect(dispatchStagingPowerWorkflow).toHaveBeenCalledTimes(dispatches)
  } finally {
    clearTimeout(timeout)
    client.destroy()
    await test.close()
  }
})

it('enforces 4 KiB after request authentication', async () => {
  const test = await dashboard()
  try {
    const json = JSON.stringify({ mode: 'status', confirmation: '' })
    for (const extra of [0, 1]) {
      const response = await fetch(test.url, {
        method: 'POST',
        headers: test.headers,
        body: json.padEnd(4096 + extra)
      })
      expect(response.status).toBe(extra === 0 ? 200 : 413)
      await response.body?.cancel()
    }
    const refused = await fetch(test.url, {
      method: 'POST',
      headers: { ...test.headers, 'x-csrf-token': 'invalid' },
      body: ' '.repeat(4097)
    })
    expect(refused.status).toBe(403)
    await refused.body?.cancel()
  } finally {
    await test.close()
  }
})
