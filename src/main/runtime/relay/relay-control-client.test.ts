import { createHash, createHmac, randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import nacl from 'tweetnacl'
import { WebSocketServer, type WebSocket } from 'ws'
import type { E2EEKeypair } from '../e2ee-keypair'
import { RelayControlClient } from './relay-control-client'

const encoder = new TextEncoder()
const HOST_PROOF_DOMAIN = 'orca-relay-host-proof/v1'
const CHALLENGE_DOMAIN = 'orca-relay-host-challenge/v1'

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.byteLength
  }
  return output
}

function uint32(value: number): Uint8Array {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value, false)
  return bytes
}

function uint64(value: number): Uint8Array {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false)
  return bytes
}

function field(name: string, value: Uint8Array): Uint8Array {
  const encodedName = encoder.encode(name)
  return concat([uint32(encodedName.byteLength), encodedName, uint32(value.byteLength), value])
}

function text(value: string): Uint8Array {
  return encoder.encode(value)
}

function buildTranscript(input: {
  origin: string
  relayKey: Uint8Array
  nonce: Uint8Array
  challengeId: string
  issuedAt: number
  expiresAt: number
  relayHostId: string
  hostKey: Uint8Array
}): Uint8Array {
  return concat([
    field('protocol', text(HOST_PROOF_DOMAIN)),
    field('version', new Uint8Array([1])),
    field('relayOrigin', text(input.origin)),
    field('relayEphemeralPublicKey', input.relayKey),
    field('challengeNonce', input.nonce),
    field('challengeId', text(input.challengeId)),
    field('issuedAt', uint64(input.issuedAt)),
    field('expiresAt', uint64(input.expiresAt)),
    field('userId', text('user-1')),
    field('profileId', text('profile-1')),
    field('organizationId', text('org-1')),
    field('relayHostId', text(input.relayHostId)),
    field('hostPublicKey', input.hostKey),
    field('assignmentEpoch', uint64(3)),
    field('previousGeneration', new Uint8Array()),
    field('resumeRequested', new Uint8Array([0]))
  ])
}

function nextJson(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.once('message', (raw) => resolve(JSON.parse(raw.toString()) as Record<string, unknown>))
  })
}

describe('RelayControlClient', () => {
  const servers: WebSocketServer[] = []
  const clients: RelayControlClient[] = []

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.closeNow()
    }
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            for (const socket of server.clients) {
              socket.terminate()
            }
            server.close(() => resolve())
          })
      )
    )
  })

  it('proves the host key and drives control/data commands without URL credentials', async () => {
    const server = new WebSocketServer({ port: 0, perMessageDeflate: false })
    servers.push(server)
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('expected TCP relay test server')
    }
    const origin = `http://127.0.0.1:${address.port}`
    const hostKeys = nacl.box.keyPair()
    const keypair: E2EEKeypair = {
      publicKey: hostKeys.publicKey,
      secretKey: hostKeys.secretKey,
      publicKeyB64: Buffer.from(hostKeys.publicKey).toString('base64')
    }
    const relayHostId = createHash('sha256')
      .update(hostKeys.publicKey)
      .digest('base64url')
      .slice(0, 16)
    const accepted = new Promise<{ socket: WebSocket; authorization: string; path: string }>(
      (resolve) => {
        server.once('connection', (socket, request) =>
          resolve({
            socket,
            authorization: String(request.headers.authorization),
            path: request.url ?? ''
          })
        )
      }
    )
    const onConnectionOpen = vi.fn()
    const onDrain = vi.fn()
    const onClose = vi.fn()
    const client = new RelayControlClient({
      cellUrl: origin,
      relayJwt: 'scoped-token',
      relayHostId,
      assignmentEpoch: 3,
      identity: { userId: 'user-1', profileId: 'profile-1', organizationId: 'org-1' },
      keypair,
      appVersion: '1.2.3',
      onConnectionOpen,
      onDrain,
      onClose
    })
    clients.push(client)
    const connecting = client.connect()
    const { socket, authorization, path } = await accepted
    expect(authorization).toBe('Bearer scoped-token')
    expect(path).toBe('/v1/host/control')
    const hello = await nextJson(socket)
    expect(hello).toMatchObject({
      type: 'host-hello',
      relayHostId,
      assignmentEpoch: 3,
      hostPublicKeyB64: keypair.publicKeyB64
    })

    const relayKeys = nacl.box.keyPair()
    const nonce = randomBytes(24)
    const secret = randomBytes(32)
    const issuedAt = Date.now()
    const expiresAt = issuedAt + 10_000
    const transcript = buildTranscript({
      origin,
      relayKey: relayKeys.publicKey,
      nonce,
      challengeId: 'challenge-1',
      issuedAt,
      expiresAt,
      relayHostId,
      hostKey: hostKeys.publicKey
    })
    const plaintext = concat([
      text(`${CHALLENGE_DOMAIN}\0`),
      uint32(transcript.byteLength),
      transcript,
      secret
    ])
    const proofMessage = nextJson(socket)
    socket.send(
      JSON.stringify({
        type: 'host-challenge',
        challengeId: 'challenge-1',
        relayEphemeralPublicKeyB64: Buffer.from(relayKeys.publicKey).toString('base64'),
        nonceB64: nonce.toString('base64'),
        ciphertextB64: Buffer.from(
          nacl.box(plaintext, nonce, hostKeys.publicKey, relayKeys.secretKey)
        ).toString('base64'),
        expiresAt
      })
    )
    const proof = await proofMessage
    expect(proof).toMatchObject({ type: 'host-challenge-ack', challengeId: 'challenge-1' })
    const expectedProof = createHmac('sha256', secret)
      .update(text(`${HOST_PROOF_DOMAIN}\0ack\0`))
      .update(transcript)
      .digest('base64')
    expect(proof.proofB64).toBe(expectedProof)

    socket.send(
      JSON.stringify({
        type: 'host-hello-ack',
        v: 1,
        generation: 4,
        controlResumeSecret: randomBytes(32).toString('base64url'),
        leaseExpiresAt: Date.now() + 60_000,
        activeConnIds: [],
        pendingConns: []
      })
    )
    await expect(connecting).resolves.toMatchObject({ generation: 4 })

    socket.send(JSON.stringify({ type: 'ping', t: Date.now() }))
    await expect(nextJson(socket)).resolves.toMatchObject({ type: 'pong' })
    socket.send(
      JSON.stringify({
        type: 'conn-open',
        connId: 'conn-1',
        connTicket: randomBytes(32).toString('base64url'),
        kind: 'invite',
        relayDeviceId: 'device-1',
        attachDeadlineMs: 10_000
      })
    )
    await vi.waitFor(() => expect(onConnectionOpen).toHaveBeenCalledOnce())

    const inviteRequest = nextJson(socket)
    const invitePromise = client.createInvite('device-1', 'invite-req')
    await expect(inviteRequest).resolves.toEqual({
      type: 'invite-create',
      reqId: 'invite-req',
      relayDeviceId: 'device-1'
    })
    socket.send(
      JSON.stringify({
        type: 'invite-created',
        reqId: 'invite-req',
        inviteToken: randomBytes(32).toString('base64url'),
        expiresAt: Date.now() + 60_000,
        maxAttempts: 3
      })
    )
    await expect(invitePromise).resolves.toMatchObject({ reqId: 'invite-req' })

    const installRequest = nextJson(socket)
    const installPromise = client.installCredential({
      reqId: 'install-req',
      relayDeviceId: 'device-1',
      newResumeTokenHash: 'A'.repeat(43),
      authorization: { mode: 'relay-basis', basisConnId: 'conn-1' }
    })
    await expect(installRequest).resolves.toEqual({
      type: 'device-credential-install',
      v: 1,
      reqId: 'install-req',
      relayDeviceId: 'device-1',
      newResumeTokenHash: 'A'.repeat(43),
      authorization: { mode: 'relay-basis', basisConnId: 'conn-1' }
    })
    socket.send(
      JSON.stringify({
        type: 'device-credential-installed',
        v: 1,
        reqId: 'install-req',
        authorizationMode: 'relay-basis',
        currentVersion: 1,
        resumeExpiresAt: Date.now() + 60_000
      })
    )
    await expect(installPromise).resolves.toMatchObject({ currentVersion: 1 })

    const statusRequest = nextJson(socket)
    const statusPromise = client.credentialInstallStatus('device-1', 'install-req')
    await expect(statusRequest).resolves.toEqual({
      type: 'device-credential-install-status',
      v: 1,
      reqId: 'install-req',
      relayDeviceId: 'device-1'
    })
    socket.send(
      JSON.stringify({
        type: 'device-credential-install-status-result',
        v: 1,
        reqId: 'install-req',
        state: 'not-found'
      })
    )
    await expect(statusPromise).resolves.toMatchObject({ state: 'not-found' })

    const confirmationRequest = nextJson(socket)
    const confirmationPromise = client.confirmResume('conn-2', 'confirm-req')
    await expect(confirmationRequest).resolves.toEqual({
      type: 'device-resume-confirm',
      v: 1,
      reqId: 'confirm-req',
      basisConnId: 'conn-2'
    })
    socket.send(
      JSON.stringify({
        type: 'device-resume-confirmed',
        v: 1,
        reqId: 'confirm-req',
        currentVersion: 1,
        acceptedAs: 'current',
        renewed: true,
        resumeExpiresAt: Date.now() + 60_000
      })
    )
    await expect(confirmationPromise).resolves.toMatchObject({ renewed: true })

    socket.send(JSON.stringify({ type: 'drain', graceMs: 5_000, recovery: 'resolve-director' }))
    await vi.waitFor(() => expect(onDrain).toHaveBeenCalledOnce())
  })
})
