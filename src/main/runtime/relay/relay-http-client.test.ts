import { describe, expect, it, vi } from 'vitest'
import nacl from 'tweetnacl'
import { cancelTrackingResponse } from '../../lib/unread-response-body.test-fixtures'
import { exchangeRelayAuthorization, requestRelayAssignment } from './relay-http-client'

describe('relay HTTP client', () => {
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
      requestRelayAssignment({
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

  it('aborts a blackholed assignment request so recovery can retry', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async (_url, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        })
    )

    await expect(
      requestRelayAssignment({
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
      requestRelayAssignment({
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
      requestRelayAssignment({
        directorUrl: 'https://relay.example',
        relayToken: 'scoped-token',
        relayHostId: 'AbCdEf0123_-xyZ9',
        fetch
      })
    ).rejects.toThrow()
    expect(cancelledBodies).toBe(2)
  })
})
