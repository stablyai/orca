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
  it('uses a bounded POST body and never puts the bearer in the URL', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            v: 1,
            cellUrl: 'https://relay-c2.onorca.dev',
            assignmentEpoch: 8,
            leaseExpiresAt: Date.now() + 60_000
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    )

    await expect(
      resolveMobileRelayEndpoint({ relay, resumeToken: 'A'.repeat(43), fetchImpl })
    ).resolves.toMatchObject({ cellUrl: 'https://relay-c2.onorca.dev', assignmentEpoch: 8 })
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('https://relay.onorca.dev/v1/resolve')
    expect(url).not.toContain('A'.repeat(43))
    expect(init).toMatchObject({ method: 'POST' })
    expect(JSON.parse(init!.body as string)).toEqual({
      v: 1,
      relayHostId: relay.relayHostId,
      resumeToken: 'A'.repeat(43)
    })
  })

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
    ).rejects.toThrow()

    const oversized = vi.fn(
      async () =>
        new Response('x'.repeat(16 * 1024 + 1), { headers: { 'content-length': '16385' } })
    )
    await expect(
      resolveMobileRelayEndpoint({ relay, resumeToken: 'A'.repeat(43), fetchImpl: oversized })
    ).rejects.toThrow(/too large/)
  })
})
