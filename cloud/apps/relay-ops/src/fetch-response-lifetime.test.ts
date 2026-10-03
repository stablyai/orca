import { once } from 'node:events'
import { createServer } from 'node:http'
import { expect, it, vi } from 'vitest'
import { RELAY_OPS_ENVIRONMENTS } from './environment-config.js'
import { GOOGLE_METRICS, readGoogleMetric } from './incident-monitor-sources.js'
import { readMonitoringSnapshot } from './monitoring-snapshot.js'
import { probeEndpointHealth, readResourceInventory } from './resource-inventory.js'

const gcloud = { accessToken: async () => 'a'.repeat(40) }
const environment = { ...RELAY_OPS_ENVIRONMENTS.staging, cells: [] }
const cases = [
  { kind: 'probe', status: 200 },
  { kind: 'probe', status: 503 },
  { kind: 'monitoring', status: 503 },
  { kind: 'inventory', status: 503 },
  { kind: 'incident', status: 503 }
] as const

it.each(cases)('closes unused $kind responses after status $status', async (scenario) => {
  let activeResponses = 0
  const server = createServer((_request, response) => {
    activeResponses++
    response.once('close', () => {
      activeResponses--
    })
    response.writeHead(scenario.status, { 'content-type': 'application/json' })
    response.write('{')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing test server port')
    const origin = `http://127.0.0.1:${address.port}`
    const fetchImpl: typeof fetch = async (input, init) => {
      if (scenario.kind === 'inventory' && !String(input).includes('googleapis.com')) {
        return new Response(null, { status: 200 })
      }
      return await fetch(origin, init)
    }
    for (let attempt = 0; attempt < 10; attempt++) {
      if (scenario.kind === 'probe') {
        const result = await probeEndpointHealth(origin, fetchImpl, { wait: async () => {} })
        expect(result.health).toBe(scenario.status === 200)
        expect(result.ready).toBe(scenario.status === 200)
      } else if (scenario.kind === 'monitoring') {
        const result = await readMonitoringSnapshot(environment, gcloud, { fetchImpl })
        expect(result.metrics.controls.available).toBe(false)
      } else if (scenario.kind === 'inventory') {
        const result = await readResourceInventory(environment, gcloud, fetchImpl)
        expect(result.director).toBeNull()
      } else {
        await expect(
          readGoogleMetric(
            environment,
            GOOGLE_METRICS[0]!,
            'test-token',
            '2026-09-22T00:00:00Z',
            '2026-09-22T00:05:00Z',
            fetchImpl
          )
        ).rejects.toThrow('Google telemetry returned 503')
      }
      await vi.waitFor(() => expect(activeResponses).toBe(0), { timeout: 1000 })
    }
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }
})

it('preserves a health reading when discarding its body fails', async () => {
  const result = await probeEndpointHealth(
    'http://test.invalid',
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error('stream failed'))
          }
        }),
        { status: 200 }
      )
  )
  expect(result.health).toBe(true)
  expect(result.ready).toBe(true)
})
