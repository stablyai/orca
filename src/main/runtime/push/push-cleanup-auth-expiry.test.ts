import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { PushGatewayClient } from './push-gateway-client'
import { buildPushChallengeFixture, createPushHostKeypair } from './push-host-challenge-fixtures'

it('retains a delete when its session proof expires before the DELETE is attempted', async () => {
  const keypair = createPushHostKeypair()
  const hostFingerprint = createHash('sha256')
    .update(keypair.publicKey)
    .digest('base64url')
    .slice(0, 16)
  let now = 1_770_000_000_000
  let deletes = 0
  const client = new PushGatewayClient({
    gatewayUrl: 'https://push.example.test',
    keypair,
    now: () => now,
    fetch: (async (url, init) => {
      if (String(url).endsWith('/challenge')) {
        const fixture = buildPushChallengeFixture({
          hostKeypair: keypair,
          hostFingerprint,
          gatewayOrigin: 'https://push.example.test',
          issuedAt: now,
          challengeId: 'challenge-1'
        })
        now += 11_000
        return Response.json(fixture.challenge)
      }
      if (String(url).endsWith('/session')) {
        return Response.json({ error: 'invalid_proof' }, { status: 401 })
      }
      if (init?.method === 'DELETE') {
        deletes++
      }
      return new Response(null, { status: 204 })
    }) as typeof fetch
  })
  expect(await client.deleteDevice('registration-1')).toEqual(false)
  expect(deletes).toBe(0)
})
