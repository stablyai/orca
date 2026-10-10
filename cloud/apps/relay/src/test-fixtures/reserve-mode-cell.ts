import { createHash, createHmac } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { buildHostProofMacInput, HOST_CHALLENGE_PLAINTEXT_DOMAIN } from '@orca-cloud/relay-contract'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import nacl from 'tweetnacl'
import WebSocket from 'ws'
import type { RawData } from 'ws'
import { CELL_FLAG_DEFAULTS, type CellFlags } from '../cell-flags.js'
import type { RelayConfig } from '../config.js'
import type { RelayDatabase } from '../database.js'
import type { AppliedControlFlags } from '../relay-control-flag-channel.js'
import { createRelayServer } from '../relay-server.js'

// One reserve-mode cell over a real database, with desktops that complete the host proof.
// For the flip-back tests (E-mix), on SQLite and on a latency-injected PostgreSQL.

export const RESERVE_MODE_CELL_ID = 'production-gce-c3'

export type ReserveModeCell = Awaited<ReturnType<typeof startReserveModeCell>>

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
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test frames are JSON objects.
        resolve(JSON.parse(data.toString()) as Record<string, unknown>)
      } catch (error) {
        reject(error)
      }
    })
    socket.once('error', reject)
  })
}

export async function startReserveModeCell(input: {
  database: RelayDatabase
  dataDir: string
  cleanup: Array<() => Promise<void> | void>
  databasePoolMax?: number
  now?: () => number
}) {
  const keys = await generateKeyPair('ES256')
  const publicJwk = await exportJWK(keys.publicKey)
  const jwksServer: Server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ keys: [{ ...publicJwk, kid: 'test-key', alg: 'ES256', use: 'sig' }] }))
  })
  await new Promise<void>((resolve) => jwksServer.listen(0, '127.0.0.1', resolve))
  input.cleanup.push(() => new Promise<void>((resolve) => jwksServer.close(() => resolve())))
  const jwksAddress = jwksServer.address()
  if (!jwksAddress || typeof jwksAddress === 'string') throw new Error('missing JWKS address')
  const issuer = `http://127.0.0.1:${jwksAddress.port}`
  const port = await unusedPort()
  const relayUrl = `http://127.0.0.1:${port}`
  const cellId = RESERVE_MODE_CELL_ID
  const config = {
    port,
    publicUrl: relayUrl,
    cellUrl: relayUrl,
    authIssuer: issuer,
    authAudience: 'orca-relay',
    jwksUrl: issuer,
    assignmentSigningKey: new Uint8Array(32),
    role: 'cell',
    cellId,
    cells: [{ id: cellId, url: relayUrl, capacityRequests: 900, connectionHardCap: 600, connectionUnobservedBound: 60 }],
    adminAudience: `${relayUrl}/admin`,
    deployServiceAccount: 'deploy@example.com',
    runtimeServiceAccount: 'runtime@example.com',
    connectionHardCap: 600,
    connectionUnobservedBound: 60,
    adminJwksUrl: `${issuer}/admin-jwks`,
    databasePoolMax: input.databasePoolMax ?? 10,
    publicAssignmentsEnabled: true,
    publicAssignmentConcurrency: 1,
    publicAssignmentQueueMax: 128,
    publicAssignmentWaitMs: 4_000,
    publicResolveConcurrency: 1,
    publicResolveWaitMs: 5_000,
    publicAssignmentRetryAfterSeconds: 5,
    dataDir: input.dataDir
  } satisfies RelayConfig
  let applied: AppliedControlFlags<CellFlags> = {
    generation: 1,
    flags: { ...CELL_FLAG_DEFAULTS, admitMode: 'reserve' }
  }
  const relay = createRelayServer(config, input.database, {
    cellFlags: () => applied,
    ...(input.now ? { now: input.now } : {})
  })
  relay.server.listen(port, '127.0.0.1')
  await new Promise<void>((resolve) => relay.server.once('listening', resolve))
  input.cleanup.push(() => new Promise<void>((resolve) => relay.server.close(() => resolve())))
  await relay.assignments.reconcileCells(config.cells)

  const host = async () => {
    const keyPair = nacl.box.keyPair()
    const hostId = createHash('sha256').update(keyPair.publicKey).digest('base64url').slice(0, 16)
    const token = await new SignJWT({ prof: 'profile-1', org: 'org-1', purpose: 'host-control', relayHostId: hostId })
      .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
      .setIssuer(issuer)
      .setAudience('orca-relay')
      .setSubject('user-1')
      .setIssuedAt()
      .setExpirationTime('30m')
      .sign(keys.privateKey)
    return { keyPair, hostId, token }
  }

  // The first control frame after the proof, and the socket's close code once it closes.
  const connect = async (identity: Awaited<ReturnType<typeof host>>, epoch: number) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/host/control`, {
      headers: { authorization: `Bearer ${identity.token}` },
      perMessageDeflate: false
    })
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })
    input.cleanup.push(() => socket.terminate())
    const closeCode = new Promise<number>((resolve) => socket.once('close', resolve))
    // A live desktop answers the relay's pings, so a test clock may run ahead.
    socket.on('message', (data: RawData) => {
      const text = data.toString()
      if (!text.includes('"ping"')) return
      const frame: unknown = JSON.parse(text)
      if (frame && typeof frame === 'object' && 'type' in frame && frame.type === 'ping' && 't' in frame) {
        socket.send(JSON.stringify({ type: 'pong', t: frame.t }))
      }
    })
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
    const challenge = await nextMessage(socket)
    const plaintext = nacl.box.open(
      Buffer.from(String(challenge.ciphertextB64), 'base64'),
      Buffer.from(String(challenge.nonceB64), 'base64'),
      Buffer.from(String(challenge.relayEphemeralPublicKeyB64), 'base64'),
      identity.keyPair.secretKey
    )
    if (!plaintext) throw new Error('challenge did not open')
    const domainLength = new TextEncoder().encode(`${HOST_CHALLENGE_PLAINTEXT_DOMAIN}\0`).length
    const transcriptLength = new DataView(plaintext.buffer, plaintext.byteOffset + domainLength, 4).getUint32(0, false)
    const transcriptStart = domainLength + 4
    const transcript = plaintext.slice(transcriptStart, transcriptStart + transcriptLength)
    const secret = plaintext.slice(transcriptStart + transcriptLength)
    socket.send(
      JSON.stringify({
        type: 'host-challenge-ack',
        challengeId: challenge.challengeId,
        proofB64: createHmac('sha256', secret).update(buildHostProofMacInput(transcript)).digest('base64')
      })
    )
    return { ack: await nextMessage(socket), socket, closeCode }
  }

  // What the ledger writer would have written about a second after the booked join.
  const insertRow = async (relayHostId: string, epoch: number, rowCellId = cellId) =>
    await input.database.query(
      `INSERT INTO relay_assignments
       (user_id, relay_host_id, cell_id, assignment_epoch, lease_expires_at, last_activity_at,
        reserved_controls, reserved_splices, reserved_invites, pending_installs,
        pending_confirmations, migration_leases)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0)`,
      ['user-1', relayHostId, rowCellId, epoch, Date.now(), Date.now()]
    )

  // A booked host, connected from memory at `epoch`, with its row written first unless asked.
  const bookedHost = async (epoch: number, options: { row?: 'now' | 'never' | string } = {}) => {
    const identity = await host()
    if (options.row === undefined || options.row === 'now') await insertRow(identity.hostId, epoch)
    else if (options.row !== 'never') await insertRow(identity.hostId, epoch, options.row)
    const outcome = relay.sessions.reserve({
      v: 1,
      directorId: 'director-a',
      items: [{ userId: 'user-1', relayHostId: identity.hostId, epoch, ttlMs: 30_000 }]
    })
    if (outcome[0]?.outcome !== 'ok') throw new Error(`booking refused: ${JSON.stringify(outcome)}`)
    const reply = await connect(identity, epoch)
    if (reply.ack.type !== 'host-hello-ack') throw new Error(`not admitted: ${JSON.stringify(reply.ack)}`)
    return { identity, ...reply }
  }

  const controlLeases = async () =>
    await input.database.query(
      `SELECT relay_host_id, cell_id, activity_id FROM relay_assignment_activity_leases
       WHERE activity_kind = 'control' ORDER BY relay_host_id`
    )

  return {
    relay,
    config,
    host,
    connect,
    insertRow,
    bookedHost,
    controlLeases,
    setAdmitMode: (admitMode: 'db' | 'reserve', flags: Partial<CellFlags> = {}) => {
      applied = { generation: applied.generation + 1, flags: { ...CELL_FLAG_DEFAULTS, ...flags, admitMode } }
    }
  }
}
