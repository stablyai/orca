import { beforeEach, describe, expect, it, vi } from 'vitest'
import nacl from 'tweetnacl'
import { cancelTrackingResponse } from '../../lib/unread-response-body.test-fixtures'
import {
  RelayAssignAbortedError,
  RelayAssignRateGate,
  sharedRelayAssignRateGate
} from './relay-assign-rate-gate'
import {
  exchangeRelayAuthorization,
  requestRelayAssignment,
  shouldRetryRelayConnectionError
} from './relay-http-client'

type AssignInput = Parameters<typeof requestRelayAssignment>[0]

function assignSuccessResponse(): Response {
  return Response.json({
    v: 1,
    cellUrl: 'https://relay-c1.example',
    assignmentEpoch: 4,
    lease: 'lease-jwt'
  })
}

// Advances only when the gate sleeps, so a wait is observable as an exact duration.
function fakeAssignClock(onSleep?: () => void) {
  let now = 1_000_000
  const sleeps: number[] = []
  return {
    sleeps,
    advance: (ms: number): void => {
      now += ms
    },
    options: {
      now: () => now,
      random: () => 0,
      sleep: async (ms: number): Promise<void> => {
        sleeps.push(ms)
        now += ms
        onSleep?.()
      }
    }
  }
}

describe('relay HTTP client', () => {
  let gate = new RelayAssignRateGate()
  beforeEach(() => {
    gate = new RelayAssignRateGate()
  })
  const assign = (input: Omit<AssignInput, 'assignRateGate'>) =>
    requestRelayAssignment({ ...input, assignRateGate: gate })

  it('exchanges only the ordinary bearer for a host-bound relay token', async () => {
    const keypair = nacl.box.keyPair()
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ relayToken: 'scoped-relay-token', expiresAt: Date.now() + 300_000 })
    )
    await expect(
      exchangeRelayAuthorization({
        endpoint: 'https://auth.example/v1/desktop/auth/relay-token',
        accessToken: 'ordinary-access-token',
        keypair: {
          ...keypair,
          publicKeyB64: Buffer.from(keypair.publicKey).toString('base64')
        },
        fetch
      })
    ).resolves.toMatchObject({ relayToken: 'scoped-relay-token' })
    const request = fetch.mock.calls[0]!
    expect(request[0]).toBe('https://auth.example/v1/desktop/auth/relay-token')
    expect(request[1]?.headers).toEqual({
      authorization: 'Bearer ordinary-access-token',
      'content-type': 'application/json'
    })
    expect(JSON.parse(String(request[1]?.body))).toEqual({
      relayHostId: expect.stringMatching(/^[A-Za-z0-9_-]{16}$/),
      hostPublicKeyB64: Buffer.from(keypair.publicKey).toString('base64')
    })
  })

  it('requests assignment without putting credentials in the URL', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({
        v: 1,
        cellUrl: 'https://relay-c1.example',
        assignmentEpoch: 4,
        lease: 'signed-assignment'
      })
    )
    await expect(
      assign({
        directorUrl: 'https://relay.example',
        relayToken: 'scoped-token',
        relayHostId: 'AbCdEf0123_-xyZ9',
        fetch
      })
    ).resolves.toMatchObject({ assignmentEpoch: 4 })
    expect(fetch.mock.calls[0]?.[0]).toBe('https://relay.example/v1/assign')
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: 'Bearer scoped-token'
    })
    expect(fetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
  })

  it('declares reconnection in the assignment body when hinted', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({
        v: 1,
        cellUrl: 'https://relay-c1.example',
        assignmentEpoch: 4,
        lease: 'lease-jwt'
      })
    )
    await expect(
      assign({
        directorUrl: 'https://relay.example',
        relayToken: 'scoped-token',
        relayHostId: 'AbCdEf0123_-xyZ9',
        reconnect: true,
        fetch
      })
    ).resolves.toMatchObject({ assignmentEpoch: 4 })
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      v: 1,
      relayHostId: 'AbCdEf0123_-xyZ9',
      reconnect: true
    })
  })

  it('sends only the coarse region and preserves reconnect when removing it', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ error: 'invalid_request' }, { status: 400 }))
      .mockResolvedValueOnce(
        Response.json({
          v: 1,
          cellUrl: 'https://relay-c1.example',
          assignmentEpoch: 4,
          lease: 'lease-jwt'
        })
      )

    await expect(
      assign({
        directorUrl: 'https://relay.example',
        relayToken: 'scoped-token',
        relayHostId: 'AbCdEf0123_-xyZ9',
        reconnect: true,
        preferredRegion: 'asia-east2',
        fetch
      })
    ).resolves.toMatchObject({ assignmentEpoch: 4 })
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      v: 1,
      relayHostId: 'AbCdEf0123_-xyZ9',
      preferredRegion: 'asia-east2',
      reconnect: true
    })
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
      v: 1,
      relayHostId: 'AbCdEf0123_-xyZ9',
      reconnect: true
    })
  })

  it('retries once unhinted when a rolled-back director rejects the hint', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ error: 'invalid_request' }, { status: 400 }))
      .mockResolvedValueOnce(
        Response.json({
          v: 1,
          cellUrl: 'https://relay-c1.example',
          assignmentEpoch: 4,
          lease: 'lease-jwt'
        })
      )
    await expect(
      assign({
        directorUrl: 'https://relay.example',
        relayToken: 'scoped-token',
        relayHostId: 'AbCdEf0123_-xyZ9',
        reconnect: true,
        fetch
      })
    ).resolves.toMatchObject({ assignmentEpoch: 4 })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
      v: 1,
      relayHostId: 'AbCdEf0123_-xyZ9'
    })
  })

  it('aborts a blackholed assignment request so recovery can retry', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async (_url, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        })
    )

    await expect(
      assign({
        directorUrl: 'https://relay.example',
        relayToken: 'scoped-token',
        relayHostId: 'AbCdEf0123_-xyZ9',
        requestDeadlineMs: 5,
        fetch
      })
    ).rejects.toMatchObject({ name: 'TimeoutError' })
  })

  it('aborts a blackholed token exchange so recovery can retry', async () => {
    const keypair = nacl.box.keyPair()
    const fetch = vi.fn<typeof globalThis.fetch>(
      async (_url, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        })
    )

    await expect(
      exchangeRelayAuthorization({
        endpoint: 'https://auth.example/v1/desktop/auth/relay-token',
        accessToken: 'ordinary-access-token',
        keypair: {
          ...keypair,
          publicKeyB64: Buffer.from(keypair.publicKey).toString('base64')
        },
        requestDeadlineMs: 5,
        fetch
      })
    ).rejects.toMatchObject({ name: 'TimeoutError' })
  })

  it('rejects data-plane supplied non-origin URLs', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({
        v: 1,
        cellUrl: 'https://relay-c1.example/path?token=bad',
        assignmentEpoch: 4,
        lease: 'signed-assignment'
      })
    )
    await expect(
      assign({
        directorUrl: 'https://relay.example',
        relayToken: 'scoped-token',
        relayHostId: 'AbCdEf0123_-xyZ9',
        fetch
      })
    ).rejects.toThrow('relay_assignment_failed_502')
  })

  it('cancels unread error-response bodies so bundled undici cannot crash on socket close', async () => {
    const keypair = nacl.box.keyPair()
    let cancelledBodies = 0
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      cancelTrackingResponse(503, () => {
        cancelledBodies += 1
      })
    )

    await expect(
      exchangeRelayAuthorization({
        endpoint: 'https://auth.example/v1/desktop/auth/relay-token',
        accessToken: 'ordinary-access-token',
        keypair: {
          ...keypair,
          publicKeyB64: Buffer.from(keypair.publicKey).toString('base64')
        },
        fetch
      })
    ).rejects.toThrow()
    await expect(
      assign({
        directorUrl: 'https://relay.example',
        relayToken: 'scoped-token',
        relayHostId: 'AbCdEf0123_-xyZ9',
        fetch
      })
    ).rejects.toThrow()
    expect(cancelledBodies).toBe(2)
  })

  it('preserves a bounded Retry-After hint on assignment overload', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(null, { status: 503, headers: { 'retry-after': '30' } })
    )

    await expect(
      assign({
        directorUrl: 'https://relay.example',
        relayToken: 'scoped-token',
        relayHostId: 'AbCdEf0123_-xyZ9',
        fetch
      })
    ).rejects.toMatchObject({
      operation: 'assignment',
      statusCode: 503,
      retryAfterMs: 30_000
    })
  })

  it('caps an excessive Retry-After hint at five minutes', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(null, { status: 503, headers: { 'retry-after': '999999' } })
    )

    await expect(
      assign({
        directorUrl: 'https://relay.example',
        relayToken: 'scoped-token',
        relayHostId: 'AbCdEf0123_-xyZ9',
        fetch
      })
    ).rejects.toMatchObject({ retryAfterMs: 5 * 60_000 })
  })
})

describe('relay assignment rate gate', () => {
  const request = (
    input: Partial<AssignInput> & Pick<AssignInput, 'fetch' | 'assignRateGate'>
  ): Promise<unknown> =>
    requestRelayAssignment({
      directorUrl: 'https://relay.example',
      relayToken: 'scoped-token',
      relayHostId: 'AbCdEf0123_-xyZ9',
      ...input
    })

  it('holds a second assignment for the same host to the director interval', async () => {
    const clock = fakeAssignClock()
    const assignRateGate = new RelayAssignRateGate(clock.options)
    const fetch = vi.fn<typeof globalThis.fetch>(async () => assignSuccessResponse())

    await request({ fetch, assignRateGate })
    expect(clock.sleeps).toEqual([])
    clock.advance(2_000)
    await request({ fetch, assignRateGate })

    expect(clock.sleeps).toEqual([1_000, 1_000, 1_000])
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('does not hold assignments for a different host or a different director', async () => {
    const clock = fakeAssignClock()
    const assignRateGate = new RelayAssignRateGate(clock.options)
    const fetch = vi.fn<typeof globalThis.fetch>(async () => assignSuccessResponse())

    await request({ fetch, assignRateGate })
    await request({ fetch, assignRateGate, relayHostId: 'OtherHost01234_x' })
    await request({ fetch, assignRateGate, directorUrl: 'https://relay-eu.example' })

    expect(clock.sleeps).toEqual([])
  })

  it('serializes concurrent callers behind one booking instead of stampeding', async () => {
    const clock = fakeAssignClock()
    const assignRateGate = new RelayAssignRateGate(clock.options)
    const fetch = vi.fn<typeof globalThis.fetch>(async () => assignSuccessResponse())

    await Promise.all([
      request({ fetch, assignRateGate }),
      request({ fetch, assignRateGate }),
      request({ fetch, assignRateGate })
    ])

    expect(clock.sleeps).toEqual(Array.from({ length: 10 }, () => 1_000))
  })

  it('keeps a Retry-After hint past the retry timer the coordinator cancels', async () => {
    const clock = fakeAssignClock()
    const assignRateGate = new RelayAssignRateGate(clock.options)
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'retry-after': '30' } }))
      .mockResolvedValueOnce(assignSuccessResponse())

    await expect(request({ fetch, assignRateGate })).rejects.toThrow('relay_assignment_failed_429')
    // A reconcile() cancels the armed retry timer and resets attempts; only the
    // gate still remembers what the director asked for. A wait beyond the
    // inline cap fails fast with the remainder instead of parking the caller
    // (pairing IPC awaits reconcile inline).
    clock.advance(6_000)
    await expect(request({ fetch, assignRateGate })).rejects.toMatchObject({
      statusCode: 429,
      retryAfterMs: 24_000
    })
    expect(clock.sleeps).toEqual([])
    expect(fetch).toHaveBeenCalledTimes(1)

    clock.advance(25_000)
    await request({ fetch, assignRateGate })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('honors a deadline raise that lands mid-wait', async () => {
    const key = 'https://relay.example AbCdEf0123_-xyZ9'
    let raised = false
    const clock = fakeAssignClock(() => {
      if (!raised) {
        raised = true
        assignRateGate.noteRetryAfter(key, 10_000)
      }
    })
    const assignRateGate = new RelayAssignRateGate(clock.options)

    await assignRateGate.reserve(key)
    await assignRateGate.reserve(key)

    // First slice consumes 1s of the 5s interval; the raise then owes 10s more.
    expect(clock.sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(11_000)
  })

  it('routes ungated callers through the shared process-wide gate', async () => {
    const reserve = vi.spyOn(sharedRelayAssignRateGate, 'reserve').mockResolvedValueOnce()
    const fetch = vi.fn<typeof globalThis.fetch>(async () => assignSuccessResponse())

    await requestRelayAssignment({
      directorUrl: 'https://relay.example',
      relayToken: 'scoped-token',
      relayHostId: 'AbCdEf0123_-xyZ9',
      fetch
    })

    expect(reserve).toHaveBeenCalledWith('https://relay.example AbCdEf0123_-xyZ9', undefined)
    reserve.mockRestore()
  })

  it('classifies a staleness abort as non-retryable', () => {
    expect(shouldRetryRelayConnectionError(new RelayAssignAbortedError())).toBe(false)
    expect(shouldRetryRelayConnectionError(new Error('socket hang up'))).toBe(true)
  })

  it('does not re-wait for the field-fallback retries of one attempt', async () => {
    const clock = fakeAssignClock()
    const assignRateGate = new RelayAssignRateGate(clock.options)
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ error: 'invalid_request' }, { status: 400 }))
      .mockResolvedValueOnce(Response.json({ error: 'invalid_request' }, { status: 400 }))
      .mockResolvedValueOnce(assignSuccessResponse())

    await request({ fetch, assignRateGate, reconnect: true, preferredRegion: 'asia-east2' })

    expect(fetch).toHaveBeenCalledTimes(3)
    expect(clock.sleeps).toEqual([])
  })

  it('aborts before sending when the caller is superseded after reservation', async () => {
    const clock = fakeAssignClock()
    const assignRateGate = new RelayAssignRateGate(clock.options)
    const fetch = vi.fn<typeof globalThis.fetch>(async () => assignSuccessResponse())
    // First reads happen inside reserve(); the last read guards the send.
    const currency = [true, false]

    await expect(
      request({ fetch, assignRateGate, isCurrent: () => currency.shift() ?? false })
    ).rejects.toBeInstanceOf(RelayAssignAbortedError)

    expect(fetch).not.toHaveBeenCalled()
  })

  it('stops field-fallback retries when the caller is superseded mid-attempt', async () => {
    const clock = fakeAssignClock()
    const assignRateGate = new RelayAssignRateGate(clock.options)
    let current = true
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      current = false
      return Response.json({ error: 'invalid_request' }, { status: 400 })
    })

    await expect(
      request({
        fetch,
        assignRateGate,
        reconnect: true,
        preferredRegion: 'asia-east2',
        isCurrent: () => current
      })
    ).rejects.toBeInstanceOf(RelayAssignAbortedError)

    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('aborts without assigning when the caller is superseded during the wait', async () => {
    let current = true
    const clock = fakeAssignClock(() => {
      current = false
    })
    const assignRateGate = new RelayAssignRateGate(clock.options)
    const fetch = vi.fn<typeof globalThis.fetch>(async () => assignSuccessResponse())

    await request({ fetch, assignRateGate })
    await expect(
      request({ fetch, assignRateGate, isCurrent: () => current })
    ).rejects.toBeInstanceOf(RelayAssignAbortedError)

    expect(clock.sleeps).toEqual([1_000])
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('prunes hosts whose interval has elapsed so the map stays bounded', async () => {
    const clock = fakeAssignClock()
    const assignRateGate = new RelayAssignRateGate(clock.options)

    await assignRateGate.reserve('https://relay.example host-a')
    await assignRateGate.reserve('https://relay.example host-b')
    await assignRateGate.reserve('https://relay.example host-c')
    expect(assignRateGate.trackedKeyCount).toBe(3)

    clock.advance(6_000)
    await assignRateGate.reserve('https://relay.example host-d')

    expect(assignRateGate.trackedKeyCount).toBe(1)
  })
})
