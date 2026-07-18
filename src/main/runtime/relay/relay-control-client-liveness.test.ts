import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import nacl from 'tweetnacl'
import type WebSocket from 'ws'
import { RelayControlClient } from './relay-control-client'

class SilentControlSocket extends EventEmitter {
  readonly send = vi.fn()
  readonly close = vi.fn()
  readonly terminate = vi.fn(() => this.emit('close', 1006))
}

function createClient(socket: SilentControlSocket, onClose = vi.fn()): RelayControlClient {
  const keys = nacl.box.keyPair()
  return new RelayControlClient({
    cellUrl: 'https://relay.example.test',
    relayJwt: 'relay-jwt',
    relayHostId: 'relay-host-1',
    assignmentEpoch: 1,
    identity: { userId: 'user-1', profileId: 'profile-1', organizationId: 'org-1' },
    keypair: {
      publicKey: keys.publicKey,
      secretKey: keys.secretKey,
      publicKeyB64: Buffer.from(keys.publicKey).toString('base64')
    },
    appVersion: '1.0.0',
    onConnectionOpen: vi.fn(),
    onDrain: vi.fn(),
    onClose,
    createSocket: () => socket as unknown as WebSocket,
    livenessTimeoutMs: 100
  })
}

async function activate(client: RelayControlClient, socket: SilentControlSocket): Promise<void> {
  const connecting = client.connect()
  socket.emit('open')
  socket.emit(
    'message',
    Buffer.from(
      JSON.stringify({
        type: 'host-hello-ack',
        v: 1,
        generation: 1,
        controlResumeSecret: 'R'.repeat(43),
        leaseExpiresAt: Date.now() + 60_000,
        activeConnIds: [],
        pendingConns: []
      })
    ),
    false
  )
  await connecting
}

describe('RelayControlClient liveness', () => {
  it('terminates an active control socket that receives no relay traffic', async () => {
    vi.useFakeTimers()
    const socket = new SilentControlSocket()
    const onClose = vi.fn()
    const client = createClient(socket, onClose)

    await activate(client, socket)
    await vi.advanceTimersByTimeAsync(101)

    expect(socket.terminate).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledWith(1006)
    vi.useRealTimers()
  })

  it('extends the deadline whenever relay traffic arrives', async () => {
    vi.useFakeTimers()
    const socket = new SilentControlSocket()
    const client = createClient(socket)

    await activate(client, socket)
    await vi.advanceTimersByTimeAsync(90)
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'ping', t: Date.now() })), false)
    await vi.advanceTimersByTimeAsync(20)
    expect(socket.terminate).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(81)
    expect(socket.terminate).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })
})
