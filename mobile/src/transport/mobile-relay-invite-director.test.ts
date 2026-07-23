import { describe, expect, it } from 'vitest'
import {
  MOBILE_RELAY_DIRECTOR_MAX_FRAME_BYTES,
  resolvePairingInviteThroughDirector
} from './mobile-relay-invite-director'

class FakeSocket {
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  send(value: string): void {
    this.sent.push(value)
  }
  close(): void {}
}

const relay = {
  v: 1 as const,
  directorUrl: 'https://relay.onorca.dev',
  cellUrl: 'https://relay-c1.onorca.dev',
  assignmentEpoch: 7,
  relayHostId: 'AbCdEf0123_-xyZ9',
  inviteToken: 'abcdefghijklmnopqrstuvwxyzABCDEFGH012345678',
  inviteExpiresAt: Date.now() + 300_000,
  e2eeFraming: 2 as const
}

describe('pairing invite director resolution', () => {
  it('authenticates only to the configured director and accepts a strictly newer move', async () => {
    const socket = new FakeSocket()
    let url = ''
    const resolving = resolvePairingInviteThroughDirector({
      relay,
      createSocket: (value) => {
        url = value
        return socket as unknown as WebSocket
      }
    })
    socket.onopen?.()
    expect(url).toBe('wss://relay.onorca.dev/v1/connect/AbCdEf0123_-xyZ9')
    expect(url).not.toContain('?')
    expect(JSON.parse(socket.sent[0]!)).toEqual({
      type: 'relay-auth',
      v: 1,
      mode: 'connect',
      credential: relay.inviteToken
    })
    socket.onmessage?.({
      data: JSON.stringify({
        type: 'relay-moved',
        v: 1,
        cellUrl: 'https://relay-c2.onorca.dev',
        assignmentEpoch: 8
      })
    })

    await expect(resolving).resolves.toMatchObject({
      cellUrl: 'https://relay-c2.onorca.dev',
      assignmentEpoch: 8
    })
  })

  it('rejects same/older epochs and untrusted extra fields', async () => {
    const socket = new FakeSocket()
    const resolving = resolvePairingInviteThroughDirector({
      relay,
      createSocket: () => socket as unknown as WebSocket
    })
    socket.onmessage?.({
      data: JSON.stringify({
        type: 'relay-moved',
        v: 1,
        cellUrl: 'https://relay-c2.onorca.dev',
        assignmentEpoch: 7,
        targetFromCell: true
      })
    })

    await expect(resolving).rejects.toThrow(/not strictly newer/)
  })

  it('rejects over-deep and oversized moves before materializing them', async () => {
    const deepSocket = new FakeSocket()
    const deep = resolvePairingInviteThroughDirector({
      relay,
      createSocket: () => deepSocket as unknown as WebSocket
    })
    deepSocket.onmessage?.({ data: `${'['.repeat(129)}0${']'.repeat(129)}` })
    await expect(deep).rejects.toThrow('invalid relay director move')

    const oversizedSocket = new FakeSocket()
    const oversized = resolvePairingInviteThroughDirector({
      relay,
      createSocket: () => oversizedSocket as unknown as WebSocket
    })
    oversizedSocket.onmessage?.({
      data: 'x'.repeat(MOBILE_RELAY_DIRECTOR_MAX_FRAME_BYTES / 2 + 1)
    })
    await expect(oversized).rejects.toThrow('invalid relay director move')
  })
})
