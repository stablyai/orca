import { describe, expect, it, vi } from 'vitest'
import { RelayDirectorHttpError, resolveMobileRelayEndpoint } from './mobile-relay-resume-director'

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

  it('carries the bounded-overload Retry-After off a rejected resolve', async () => {
    const resolveWith = (headers: Record<string, string>) =>
      resolveMobileRelayEndpoint({
        relay,
        resumeToken: 'A'.repeat(43),
        fetchImpl: vi.fn(async () => new Response(null, { status: 503, headers }))
      })

    await expect(resolveWith({ 'retry-after': '30' })).rejects.toMatchObject({
      status: 503,
      retryAfterMs: 30_000,
      message: 'relay director resolve failed (503)'
    })
    // An HTTP-date form resolves against the clock, and both forms clamp.
    const httpDate = new Date(Date.now() + 10 * 60_000).toUTCString()
    await expect(resolveWith({ 'retry-after': httpDate })).rejects.toMatchObject({
      retryAfterMs: 120_000
    })
    await expect(resolveWith({ 'retry-after': '999999' })).rejects.toMatchObject({
      retryAfterMs: 120_000
    })
    // A past date or unparseable header leaves the local backoff in charge.
    const pastDate = new Date(Date.now() - 10 * 60_000).toUTCString()
    await expect(resolveWith({ 'retry-after': pastDate })).rejects.toMatchObject({
      retryAfterMs: null
    })
    await expect(resolveWith({ 'retry-after': 'soon-ish' })).rejects.toMatchObject({
      retryAfterMs: null
    })
    await expect(resolveWith({})).rejects.toMatchObject({
      status: 503,
      retryAfterMs: null
    })
    await expect(resolveWith({})).rejects.toBeInstanceOf(RelayDirectorHttpError)
  })
})
