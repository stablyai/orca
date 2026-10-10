import { createHash, createHmac } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { buildHostProofMacInput, HOST_CHALLENGE_PLAINTEXT_DOMAIN } from '@orca-cloud/relay-contract'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import nacl from 'tweetnacl'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import type { RawData } from 'ws'
import { CELL_FLAG_DEFAULTS, type CellFlags } from './cell-flags.js'
import type { RelayConfig } from './config.js'
import { PostgresDatabase } from './database.js'
import type { AppliedControlFlags } from './relay-control-flag-channel.js'
import { createRelayServer, HOST_HELLO_SHED_OLDEST_WAIT_MS } from './relay-server.js'

// A step-5 cell whose database pool is wedged: every query waits forever and the hello shed
// is armed. Booked and recently seated hosts must still connect; everything else must not.

async function unusedPort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing test port')
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}

function stalledPool() {
  const pool = {
    options: { max: 2, connectionTimeoutMillis: 0 },
    totalCount: 2,
    idleCount: 0,
    waitingCount: 0,
    connect: () => {
      pool.waitingCount++
      return new Promise<never>(() => {})
    },
    end: async () => undefined
  }
  return pool
}

function cellConfig(port: number, issuer: string): RelayConfig {
  const relayUrl = `http://127.0.0.1:${port}`
  return {
    port,
    publicUrl: relayUrl,
    cellUrl: relayUrl,
    authIssuer: issuer,
    authAudience: 'orca-relay',
    jwksUrl: issuer,
    assignmentSigningKey: new Uint8Array(32),
    role: 'cell',
    cellId: 'production-gce-c3',
    cells: [{ id: 'production-gce-c3', url: relayUrl, capacityRequests: 4_000 }],
    adminAudience: `${relayUrl}/admin`,
    deployServiceAccount: 'deploy@example.com',
    runtimeServiceAccount: 'runtime@example.com',
    connectionHardCap: 600,
    connectionUnobservedBound: 60,
    adminJwksUrl: `${issuer}/admin-jwks`,
    databasePoolMax: 2,
    publicAssignmentsEnabled: true,
    publicAssignmentConcurrency: 1,
    publicAssignmentQueueMax: 128,
    publicAssignmentWaitMs: 4_000,
    publicResolveConcurrency: 1,
    publicResolveWaitMs: 5_000,
    publicAssignmentRetryAfterSeconds: 5,
    dataDir: './test-data'
  }
}

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    socket.once('message', (data: RawData) => {
      try {
        resolve(JSON.parse(data.toString()) as Record<string, unknown>)
      } catch (error) {
        reject(error)
      }
    })
    socket.once('error', reject)
  })
}

describe('a reserve-mode cell admits from memory with its database wedged', () => {
  const cleanup: Array<() => Promise<void> | void> = []

  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close()
    vi.restoreAllMocks()
  })

  async function startCell(flags: Partial<CellFlags>) {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const keys = await generateKeyPair('ES256')
    const publicJwk = await exportJWK(keys.publicKey)
    const jwksServer: Server = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({ keys: [{ ...publicJwk, kid: 'test-key', alg: 'ES256', use: 'sig' }] })
      )
    })
    await new Promise<void>((resolve) => jwksServer.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>((resolve) => jwksServer.close(() => resolve())))
    const jwksAddress = jwksServer.address()
    if (!jwksAddress || typeof jwksAddress === 'string') throw new Error('missing JWKS address')
    const issuer = `http://127.0.0.1:${jwksAddress.port}`
    const realNow = Date.now()
    let elapsedMs = 0
    vi.spyOn(Date, 'now').mockImplementation(() => realNow + elapsedMs)
    const database = new PostgresDatabase(stalledPool() as never)
    for (let index = 0; index < 2; index++) void database.query('SELECT 1').catch(() => {})
    elapsedMs += HOST_HELLO_SHED_OLDEST_WAIT_MS
    let applied: AppliedControlFlags<CellFlags> = {
      generation: 3,
      flags: { ...CELL_FLAG_DEFAULTS, ...flags }
    }
    const port = await unusedPort()
    const relay = createRelayServer(cellConfig(port, issuer), database, {
      cellFlags: () => applied
    })
    relay.server.listen(port, '127.0.0.1')
    await new Promise<void>((resolve) => relay.server.once('listening', resolve))
    cleanup.push(() => new Promise<void>((resolve) => relay.server.close(() => resolve())))

    const host = async () => {
      const keyPair = nacl.box.keyPair()
      const hostId = createHash('sha256').update(keyPair.publicKey).digest('base64url').slice(0, 16)
      const token = await new SignJWT({
        prof: 'profile-1',
        org: 'org-1',
        purpose: 'host-control',
        relayHostId: hostId
      })
        .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
        .setIssuer(issuer)
        .setAudience('orca-relay')
        .setSubject('user-1')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(keys.privateKey)
      return { keyPair, hostId, token }
    }

    // The upgrade status, or the first control frame after the proof.
    const connect = async (
      identity: Awaited<ReturnType<typeof host>>,
      epoch: number
    ): Promise<{ status: number; ack?: Record<string, unknown>; socket?: WebSocket }> => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/host/control`, {
        headers: { authorization: `Bearer ${identity.token}` },
        perMessageDeflate: false
      })
      const opened = await new Promise<{ status: number }>((resolve, reject) => {
        socket.once('unexpected-response', (request, response) => {
          resolve({ status: response.statusCode ?? 0 })
          request.destroy()
        })
        socket.once('open', () => resolve({ status: 101 }))
        socket.once('error', reject)
      })
      if (opened.status !== 101) return opened
      cleanup.push(() => socket.terminate())
      socket.send(
        JSON.stringify({
          type: 'host-hello',
          v: 1,
          relayHostId: identity.hostId,
          assignmentEpoch: epoch,
          hostPublicKeyB64: Buffer.from(identity.keyPair.publicKey).toString('base64'),
          appVersion: 'test'
        })
      )
      const challenge = await Promise.race([
        nextMessage(socket),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 500))
      ])
      if (!challenge || challenge.type !== 'host-challenge') return { status: 101, socket }
      const plaintext = nacl.box.open(
        Buffer.from(String(challenge.ciphertextB64), 'base64'),
        Buffer.from(String(challenge.nonceB64), 'base64'),
        Buffer.from(String(challenge.relayEphemeralPublicKeyB64), 'base64'),
        identity.keyPair.secretKey
      )!
      const domainLength = new TextEncoder().encode(`${HOST_CHALLENGE_PLAINTEXT_DOMAIN}\0`).length
      const transcriptLength = new DataView(
        plaintext.buffer,
        plaintext.byteOffset + domainLength,
        4
      ).getUint32(0, false)
      const transcriptStart = domainLength + 4
      const transcript = plaintext.slice(transcriptStart, transcriptStart + transcriptLength)
      const secret = plaintext.slice(transcriptStart + transcriptLength)
      socket.send(
        JSON.stringify({
          type: 'host-challenge-ack',
          challengeId: challenge.challengeId,
          proofB64: createHmac('sha256', secret)
            .update(buildHostProofMacInput(transcript))
            .digest('base64')
        })
      )
      return { status: 101, ack: await nextMessage(socket), socket }
    }

    const book = (identity: Awaited<ReturnType<typeof host>>, epoch: number) =>
      relay.sessions.reserve({
        v: 1,
        directorId: 'director-a',
        items: [{ userId: 'user-1', relayHostId: identity.hostId, epoch, ttlMs: 30_000 }]
      })

    return {
      relay,
      host,
      connect,
      book,
      setFlags: (next: Partial<CellFlags>) => {
        applied = { generation: applied.generation + 1, flags: { ...CELL_FLAG_DEFAULTS, ...next } }
      }
    }
  }

  it('answers a director dry run only while reserveDryRun is on, and books nothing either way', async () => {
    const cell = await startCell({})
    const identity = await cell.host()
    const check = () =>
      cell.relay.sessions.reserve({
        v: 1,
        directorId: 'director-a',
        dryRun: true,
        items: [{ userId: 'user-1', relayHostId: identity.hostId, epoch: 7, ttlMs: 30_000 }]
      })
    expect(check()).toEqual([{ outcome: 'off' }])
    cell.setFlags({ reserveDryRun: true })
    expect(check()).toEqual([{ outcome: 'ok' }])
    expect(cell.relay.sessions.reserveCounts()?.bookings).toBe(0)
    // A real booking on a database-mode cell stays off, whatever the dry-run switch says.
    expect(cell.book(identity, 7)).toEqual([{ outcome: 'off' }])
  })

  it('connects a booked host, and only at its booked epoch, without a database read', async () => {
    const cell = await startCell({ admitMode: 'reserve' })
    const booked = await cell.host()
    expect(cell.book(booked, 7)).toEqual([{ outcome: 'ok' }])
    const stranger = await cell.host()
    // No booking and no seat: the wedged pool sheds it, as today.
    expect((await cell.connect(stranger, 7)).status).toBe(503)
    const reply = await cell.connect(booked, 7)
    expect(reply.ack).toMatchObject({ type: 'host-hello-ack', generation: 1 })
    const page = cell.relay.sessions.seatFeed(null)
    expect('full' in page && page.full).toMatchObject([{ relayHostId: booked.hostId, epoch: 7 }])
    const changes = cell.relay.sessions.seatFeed(0)
    expect('changes' in changes && changes.changes.map((change) => [change.kind, change.reservedBy])).toEqual([
      ['reserve', 'director-a'],
      ['join', 'director-a']
    ])
  })

  it('lets a host that just left rejoin at the same epoch from memory', async () => {
    const cell = await startCell({ admitMode: 'reserve' })
    const identity = await cell.host()
    cell.book(identity, 4)
    const first = await cell.connect(identity, 4)
    expect(first.ack).toMatchObject({ type: 'host-hello-ack' })
    first.socket!.close()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect((await cell.connect(identity, 4)).ack).toMatchObject({ type: 'host-hello-ack' })
    // A different epoch is not the seat it remembers, so it falls to the wedged database.
    expect((await cell.connect(identity, 5)).ack).toBeUndefined()
  })

  it('keeps today’s path when the switch is off, even for a booking made while it was on', async () => {
    const cell = await startCell({ admitMode: 'reserve' })
    const identity = await cell.host()
    cell.book(identity, 2)
    cell.setFlags({ admitMode: 'db' })
    expect((await cell.connect(identity, 2)).status).toBe(503)
    expect(cell.book(identity, 3)).toEqual([{ outcome: 'off' }])
  })

  it('demotes exactly the seat a director names, and repeats are one demotion', async () => {
    const cell = await startCell({ admitMode: 'reserve' })
    const identity = await cell.host()
    cell.book(identity, 9)
    await cell.connect(identity, 9)
    const page = cell.relay.sessions.seatFeed(null)
    const joinedAt = 'full' in page ? page.full[0]!.joinedAt : -1
    const seat = { v: 1 as const, userId: 'user-1', relayHostId: identity.hostId, epoch: 9 }
    expect(cell.relay.sessions.demote({ ...seat, joinedAt: joinedAt - 1 })).toBe('not-seated')
    expect(cell.relay.sessions.demote({ ...seat, joinedAt })).toBe('demoted')
    expect(cell.relay.sessions.demote({ ...seat, joinedAt })).toBe('already-demoted')
    const changes = cell.relay.sessions.seatFeed(0)
    expect('changes' in changes && changes.changes.at(-1)?.kind).toBe('drain-only')
    // A demoted seat no longer holds its epoch against a new booking.
    expect(cell.book(identity, 9)).toEqual([{ outcome: 'ok' }])
  })
})
