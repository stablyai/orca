import { afterEach, describe, expect, it } from 'vitest'
import {
  cleanupConnectorHarnesses,
  createConnectorHarness
} from './connector-server-harness.test-fixture.js'

afterEach(cleanupConnectorHarnesses)

describe('connector server', () => {
  it('reports health and database readiness', async () => {
    const { request } = await createConnectorHarness()
    expect(await (await request('/health')).json()).toEqual({ ok: true, mode: 'active' })
    expect((await request('/ready')).status).toBe(200)
  })

  it('answers only health and readiness in validation mode', async () => {
    const { request } = await createConnectorHarness({ mode: 'validation' })
    expect((await request('/health')).status).toBe(200)
    expect((await request('/v1/connector/poll', { method: 'POST' })).status).toBe(503)
  })
})
