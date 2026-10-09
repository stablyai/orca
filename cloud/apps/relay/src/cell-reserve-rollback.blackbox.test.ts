import { createHash, createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildHostProofMacInput, HOST_CHALLENGE_PLAINTEXT_DOMAIN } from '@orca-cloud/relay-contract'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import nacl from 'tweetnacl'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import type { RawData } from 'ws'
import { CELL_FLAG_DEFAULTS, type CellFlags } from './cell-flags.js'
import type { RelayConfig } from './config.js'
import { openRelayDatabase } from './database.js'
import type { AppliedControlFlags } from './relay-control-flag-channel.js'
import { createRelayServer } from './relay-server.js'

// Flip back (E-mix): a cell leaves reserve mode with hosts it admitted from memory. Nobody is
// disconnected, and the database ends up holding exactly the leases its seat report names.

async function unusedPort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing test port')
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
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

const byHost = (left: Record<string, unknown>, right: Record<string, unknown>) =>
  String(left.relay_host_id) < String(right.relay_host_id) ? -1 : 1

async function until(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not reached')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

describe('flipping a reserve-mode cell back to the database', () => {
  const cleanup: Array<() => Promise<void> | void> = []

  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close()
    vi.restoreAllMocks()
  })

  it('registers every memory-admitted control without disconnecting any, matching the seat report', async () => {
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
    const port = await unusedPort()
    const relayUrl = `http://127.0.0.1:${port}`
    const dataDir = mkdtempSync(join(tmpdir(), 'orca-relay-reserve-rollback-'))
    cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }))
    const database = await openRelayDatabase({ dataDir })
    cleanup.push(() => database.close())
    const config = {
      port,
      publicUrl: relayUrl,
      cellUrl: relayUrl,
      authIssuer: issuer,
      authAudience: 'orca-relay',
      jwksUrl: issuer,
      assignmentSigningKey: new Uint8Array(32),
      role: 'cell',
      cellId: 'production-gce-c3',
      cells: [
        {
          id: 'production-gce-c3',
          url: relayUrl,
          capacityRequests: 900,
          connectionHardCap: 600,
          connectionUnobservedBound: 60
        }
      ],
      adminAudience: `${relayUrl}/admin`,
      deployServiceAccount: 'deploy@example.com',
      runtimeServiceAccount: 'runtime@example.com',
      connectionHardCap: 600,
      connectionUnobservedBound: 60,
      adminJwksUrl: `${issuer}/admin-jwks`,
      databasePoolMax: 10,
      publicAssignmentsEnabled: true,
      publicAssignmentConcurrency: 1,
      publicAssignmentQueueMax: 128,
      publicAssignmentWaitMs: 4_000,
      publicResolveConcurrency: 1,
      publicResolveWaitMs: 5_000,
      publicAssignmentRetryAfterSeconds: 5,
      dataDir
    } satisfies RelayConfig
    let applied: AppliedControlFlags<CellFlags> = {
      generation: 1,
      flags: { ...CELL_FLAG_DEFAULTS, admitMode: 'reserve' }
    }
    const relay = createRelayServer(config, database, { cellFlags: () => applied })
    relay.server.listen(port, '127.0.0.1')
    await new Promise<void>((resolve) => relay.server.once('listening', resolve))
    cleanup.push(() => new Promise<void>((resolve) => relay.server.close(() => resolve())))
    await relay.assignments.reconcileCells(config.cells)

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


    const controlLeases = async () =>
      await database.query(
        `SELECT relay_host_id, cell_id, activity_id FROM relay_assignment_activity_leases
         WHERE activity_kind = 'control' ORDER BY relay_host_id`
      )

    const insertRow = async (relayHostId: string, epoch: number) =>
      await database.query(
        `INSERT INTO relay_assignments
         (user_id, relay_host_id, cell_id, assignment_epoch, lease_expires_at, last_activity_at,
          reserved_controls, reserved_splices, reserved_invites, pending_installs,
          pending_confirmations, migration_leases)
         VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0)`,
        ['user-1', relayHostId, 'production-gce-c3', epoch, Date.now(), Date.now()]
      )
    let lateRow: (() => Promise<unknown>) | undefined
    const sockets: WebSocket[] = []
    for (let index = 0; index < 3; index += 1) {
      const identity = await host()
      // The ledger writer's row (after the fact) is what a flip back registers against.
      const row = { assignmentEpoch: 5 + index }
      // The last host's row lands only after the flip: the ledger lags by up to a second.
      if (index === 2) {
        lateRow = async () => await insertRow(identity.hostId, row.assignmentEpoch)
      } else {
        await insertRow(identity.hostId, row.assignmentEpoch)
      }
      expect(
        relay.sessions.reserve({
          v: 1,
          directorId: 'director-a',
          items: [
            { userId: 'user-1', relayHostId: identity.hostId, epoch: row.assignmentEpoch, ttlMs: 30_000 }
          ]
        })
      ).toEqual([{ outcome: 'ok' }])
      const reply = await connect(identity, row.assignmentEpoch)
      expect(reply.ack).toMatchObject({ type: 'host-hello-ack' })
      sockets.push(reply.socket!)
    }
    // Admitted from memory: no lease was taken.
    expect(await controlLeases()).toEqual([])

    applied = { generation: 2, flags: { ...CELL_FLAG_DEFAULTS, admitMode: 'db' } }
    await until(async () => (await controlLeases()).length === 2)
    await lateRow!()
    await until(async () => (await controlLeases()).length === 3)
    await until(async () => relay.sessions.reregistrationPending() === 0)

    expect(sockets.every((socket) => socket.readyState === WebSocket.OPEN)).toBe(true)
    const page = relay.sessions.seatFeed(null)
    const seats = 'full' in page ? page.full : []
    expect(
      seats
        .map((seat) => ({
          relay_host_id: seat.relayHostId,
          cell_id: 'production-gce-c3',
          activity_id: `control:production-gce-c3:${seat.generation}`
        }))
        .sort(byHost)
    ).toEqual((await controlLeases()).sort(byHost))
    // A second flip back has nothing left to register.
    expect(relay.sessions.reregisterMemoryControls()).toBe(0)
  }, 30_000)
})
