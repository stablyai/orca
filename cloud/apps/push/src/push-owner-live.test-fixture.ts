import { expect, it, vi } from 'vitest'
import {
  companion,
  headers,
  integer,
  ownerCleanup,
  text
} from './push-owner-integration.test-fixture.js'
import { createPushServerHarness } from './push-server-harness.test-fixture.js'

it('serves live production route/registration/dispatch and fenced settlement to the owner parent', async () => {
  const h = await createPushServerHarness()
  const decisions: string[] = []
  const admission = h.server.deliveryStore.admission.bind(h.server.deliveryStore)
  const observed = vi.spyOn(h.server.deliveryStore, 'admission').mockImplementation((queued) => {
    const actual = admission(queued)
    return {
      ...actual,
      acquire: async (device) => {
        const decision = await actual.acquire(device)
        decisions.push(decision)
        return decision
      }
    }
  })
  let primary: { failed: true; error: unknown } | undefined
  try {
    await companion('cloud', async (op, data) => {
      if (op === 'http') {
        const response = await h.server.app.request(text(data.url), {
          method: text(data.method),
          headers: headers(data.headers),
          ...(data.body === undefined ? {} : { body: text(data.body) })
        })
        return {
          status: response.status,
          headers: Object.fromEntries(response.headers),
          body: await response.text()
        }
      }
      if (op === 'advance') {
        h.advanceClock(integer(data.delta))
        return null
      }
      if (op === 'snapshot') {
        return {
          devices: await h.database.query('SELECT token, route_key FROM push_devices'),
          declarations: await h.database.query('SELECT * FROM push_route_declarations'),
          claims: await h.database.query(
            'SELECT state, route_key AS winner_route_key FROM push_occurrence_domains'
          ),
          pending: await h.database.query('SELECT state FROM push_delivery_batches'),
          recipients: await h.database.query('SELECT * FROM push_event_recipients'),
          decisions,
          fcmProviders: h.fcmRequests.map((request) => ({ body: request.body })),
          providers: h.apnsRequests.map((request) => ({ path: request.path, body: request.body }))
        }
      }
      if (op === 'flush') {
        await h.flushDeliveries()
        return null
      }
      throw new Error(`Unknown cloud command ${op}`)
    })
    // The parent checks exact payload/claim/queue evidence; this child must reach real teardown.
    expect(h.apnsRequests.length).toBeGreaterThan(0)
  } catch (error) {
    primary = { failed: true, error }
  }
  const cleanup = ownerCleanup(primary)
  await cleanup.run(() => observed.mockRestore())
  await cleanup.run(() => h.close())
  cleanup.finish()
}, 120_000)
