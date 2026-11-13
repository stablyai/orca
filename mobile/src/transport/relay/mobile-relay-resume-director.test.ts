import { describe, expect, it } from 'vitest'
import { resolveMobileRelayEndpoint } from './mobile-relay-resume-director'

const relay = {
  v: 1 as const,
  directorUrl: 'https://relay.onorca.dev',
  cellUrl: 'https://relay-old.onorca.dev',
  assignmentEpoch: 7,
  relayHostId: 'AbCdEf0123_-xyZ9',
  e2eeFraming: 2 as const
}

describe('mobile relay resume director', () => {
  it('rejects oversized bodies despite an underreported content length', async () => {
    const oversizedBody =
      ' '.repeat(16 * 1024) +
      JSON.stringify({
        v: 1,
        cellUrl: 'https://relay-c2.onorca.dev',
        assignmentEpoch: 8,
        leaseExpiresAt: 1
      })
    await expect(
      resolveMobileRelayEndpoint({
        relay,
        resumeToken: 'A'.repeat(43),
        fetchImpl: async () => new Response(oversizedBody, { headers: { 'content-length': '1' } })
      })
    ).rejects.toThrow(/too large/)
  })
})
