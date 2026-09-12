import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import nacl from 'tweetnacl'
import type WebSocket from 'ws'
import { RelayControlClient } from './relay-control-client'

// Teardown that runs before — or twice after — the first successful connect.
// Every field closeNow touches has to be initialised at 'idle', and a second
// pass must not re-fire onClose or leave the connect deadline armed.
class FakeSocket extends EventEmitter {
  readonly OPEN = 1
  readyState = 0
  readonly sent: string[] = []
  readonly terminate = vi.fn()
  readonly close = vi.fn()

  send(payload: string): void {
    this.sent.push(payload)
  }

  open(): void {
    this.readyState = this.OPEN
    this.emit('open')
  }

  deliver(message: object): void {
    this.emit('message', Buffer.from(JSON.stringify(message)), false)
  }
}

const keys = nacl.box.keyPair()

function client(onClose = vi.fn()): { control: RelayControlClient; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = []
  const control = new RelayControlClient({
    cellUrl: 'http://127.0.0.1:1/',
    relayJwt: 'scoped-token',
    relayHostId: 'AbCdEf0123_-xyZ9',
    assignmentEpoch: 1,
    identity: { userId: 'user-1', profileId: 'profile-1', organizationId: 'org-1' },
    keypair: { ...keys, publicKeyB64: Buffer.from(keys.publicKey).toString('base64') },
    appVersion: '1.4.188',
    onConnectionOpen: vi.fn(),
    onDrain: vi.fn(),
    onClose,
    createSocket: () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket as unknown as WebSocket
    }
  })
  return { control, sockets }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('RelayControlClient teardown before the first connect', () => {
  it('closes cleanly at idle, when no socket or watchdog was ever created', () => {
    const onClose = vi.fn()
    const { control, sockets } = client(onClose)

    expect(control.isLive()).toBe(false)
    expect(() => control.closeNow()).not.toThrow()

    expect(sockets).toHaveLength(0)
    expect(onClose).not.toHaveBeenCalled()
    expect(control.pendingRequestCount).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('refuses a connect after teardown rather than reopening into a closed client', async () => {
    const { control, sockets } = client()
    control.closeNow()

    await expect(control.connect()).rejects.toThrow('relay_control_already_started')
    expect(sockets).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects a control request issued before connect without stranding a deadline', async () => {
    const { control } = client()

    await expect(control.revokeDevice('device-1', 'req-1')).rejects.toThrow(
      'relay_control_not_active'
    )
    expect(control.pendingRequestCount).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('RelayControlClient teardown twice', () => {
  it('settles the connect once and disarms the deadline on the first close', async () => {
    const onClose = vi.fn()
    const { control, sockets } = client(onClose)
    const connecting = control.connect()
    expect(vi.getTimerCount()).toBe(1)

    control.closeNow()
    await expect(connecting).rejects.toThrow('relay_control_closed')
    expect(vi.getTimerCount()).toBe(0)
    expect(sockets[0]!.terminate).toHaveBeenCalledTimes(1)

    control.closeNow()
    // The socket handle is dropped on the first pass, so the second is inert.
    expect(sockets[0]!.terminate).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('leaves nothing armed when an active control is closed twice', async () => {
    const { control, sockets } = client()
    const connecting = control.connect()
    const socket = sockets[0]!
    socket.open()
    socket.deliver({
      type: 'host-hello-ack',
      v: 1,
      generation: 1,
      controlResumeSecret: 'A'.repeat(43),
      leaseExpiresAt: Date.now() + 60_000,
      activeConnIds: [],
      pendingConns: []
    })
    await connecting
    expect(control.isLive()).toBe(true)
    // Only the silence watchdog: activation already disarmed the connect deadline.
    expect(vi.getTimerCount()).toBe(1)

    const pending = control.createInvite('device-1', 'req-1')
    const rejection = expect(pending).rejects.toThrow('relay_control_closed')
    expect(control.pendingRequestCount).toBe(1)

    control.closeNow()
    await rejection
    expect(control.isLive()).toBe(false)
    expect(control.pendingRequestCount).toBe(0)
    expect(vi.getTimerCount()).toBe(0)

    control.closeNow()
    expect(vi.getTimerCount()).toBe(0)
    expect(socket.terminate).toHaveBeenCalledTimes(1)
  })
})
