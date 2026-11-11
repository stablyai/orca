import { describe, expect, it, vi } from 'vitest'
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
  it('rejects non-canonical targets and oversized bodies', async () => {
    const badTarget = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            v: 1,
            cellUrl: 'http://relay-c2.onorca.dev',
            assignmentEpoch: 8,
            leaseExpiresAt: 1
          })
        )
    )
    await expect(
      resolveMobileRelayEndpoint({ relay, resumeToken: 'A'.repeat(43), fetchImpl: badTarget })
    ).rejects.toThrow(/cellUrl/)

    const oversized = vi.fn(
      async () =>
        new Response('x'.repeat(16 * 1024 + 1), { headers: { 'content-length': '16385' } })
    )
    await expect(
      resolveMobileRelayEndpoint({ relay, resumeToken: 'A'.repeat(43), fetchImpl: oversized })
    ).rejects.toThrow(/too large/)

    const oversizedBody =
      ' '.repeat(16 * 1024) +
      JSON.stringify({
        v: 1,
        cellUrl: 'https://relay-c2.onorca.dev',
        assignmentEpoch: 8,
        leaseExpiresAt: 1
      })
    for (const headers of [new Headers(), new Headers({ 'content-length': '1' })]) {
      await expect(
        resolveMobileRelayEndpoint({
          relay,
          resumeToken: 'A'.repeat(43),
          fetchImpl: async () => new Response(oversizedBody, { headers })
        })
      ).rejects.toThrow(/too large/)
    }
  })
})
