import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPushHostKeypair } from '../host-auth/host-challenge-answering.test-fixture.js'
import { createPushServerHarness } from './push-server-harness.test-fixture.js'

describe('push gateway authentication and device routes', () => {
  let harness: Awaited<ReturnType<typeof createPushServerHarness>>

  beforeEach(async () => {
    harness = await createPushServerHarness()
  })

  afterEach(async () => {
    await harness.close()
  })

  it('lets only the owning host delete a registration', async () => {
    const ownerToken = await harness.signIn(createPushHostKeypair(14))
    const intruderToken = await harness.signIn(createPushHostKeypair(15))
    const registrationId = await harness.registerAndroid(ownerToken)

    const forbidden = await harness.authorized(
      `/v1/devices/${registrationId}`,
      { method: 'DELETE' },
      intruderToken
    )
    expect(forbidden.status).toBe(404)
    expect(await forbidden.json()).toEqual({ error: 'not_found' })
    expect(await harness.server.devices.findById(registrationId)).not.toBeNull()
  })
})
