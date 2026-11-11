import type { ChildProcess } from 'node:child_process'
import { spawnProcess } from '@orca/process-host'
import { createHash, createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'

import {
  buildHostProofMacInput,
  HOST_CHALLENGE_PLAINTEXT_DOMAIN
} from '@orca-cloud/relay-contract/host-proof-transcript'
import nacl from 'tweetnacl'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import type { RawData } from 'ws'

import { RelayAssignmentStore } from './assignment/assignment-store.js'
import {
  encodeMembership,
  type CellAdmissionMembership
} from './cell/admission/cell-admission-selector.js'
import { openRelayDatabase } from './database/database.js'

const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const assignmentKey = 'test-assignment-key-with-at-least-32-bytes'
let relayProcess: ChildProcess
let jwksServer: Server
let relayUrl: string
let issuer: string
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey']
let adminPrivateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey']
let relayDataDirectory: string
let adminAudience: string
let forwardedSourceSequence = 0

function forwardedHeaders(): Record<string, string> {
  forwardedSourceSequence++
  return {
    'x-forwarded-for': `spoofed, 192.0.2.${forwardedSourceSequence}, 35.191.0.1`
  }
}

async function unusedPort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing test port')
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
  return address.port
}

async function stopRelay(
  child: ChildProcess | undefined,
  signal: NodeJS.Signals = 'SIGKILL'
): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return
  }
  const closed = new Promise<void>((resolveClose) => child.once('close', () => resolveClose()))
  child.kill(signal)
  await closed
}

async function waitForRelay(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolveReady, reject) => {
    let stderr = ''
    const cleanup = (): void => {
      clearTimeout(timeout)
      child.stdout?.off('data', onOutput)
      child.stderr?.off('data', onErrorOutput)
      child.off('exit', onExit)
    }
    const onOutput = (chunk: Buffer): void => {
      if (chunk.toString().includes('[orca-relay] listening')) {
        cleanup()
        resolveReady()
      }
    }
    const onErrorOutput = (chunk: Buffer): void => {
      stderr += chunk.toString()
    }
    const onExit = (code: number | null): void => {
      cleanup()
      reject(new Error(`relay exited before ready: ${code}\n${stderr}`))
    }
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('relay did not start'))
    }, 10_000)
    child.stdout?.on('data', onOutput)
    child.stderr?.on('data', onErrorOutput)
    child.once('exit', onExit)
  })
}

async function relayToken(audience: string, relayHostId = 'abcdefghijklmnop'): Promise<string> {
  return await new SignJWT({
    prof: 'profile-1',
    org: 'org-1',
    purpose: 'host-control',
    relayHostId
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject('user-1')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey)
}

async function adminToken(): Promise<string> {
  return await googleServiceToken(adminAudience)
}

async function googleServiceToken(audience: string, email = 'deploy@example.com'): Promise<string> {
  return await new SignJWT({ email, email_verified: true })
    .setProtectedHeader({ alg: 'RS256', kid: 'admin-key' })
    .setIssuer('https://accounts.google.com')
    .setAudience(audience)
    .setSubject('deploy-subject')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(adminPrivateKey)
}

async function postCellHeartbeat(
  directorUrl: string,
  cell: { id: string; url: string },
  overrides: { incarnation?: string; startedAt?: number; ready?: boolean } = {}
): Promise<Response> {
  const audience = `${directorUrl}/v1/admin/cell-heartbeat`
  return await fetch(audience, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${await googleServiceToken(audience)}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      v: 1,
      cellId: cell.id,
      cellUrl: cell.url,
      cellIncarnation: overrides.incarnation ?? '11111111-1111-4111-8111-111111111111',
      startedAt: overrides.startedAt ?? Date.now(),
      ready: overrides.ready ?? true,
      observedRequests: 0
    })
  })
}

function spawnTopologyRelay(input: {
  url: string
  dataDirectory: string
  role: 'director' | 'cell'
  cellId: string
  cells?: Array<{ id: string; url: string; capacityRequests: number }>
}): ChildProcess {
  return spawnProcess({
    program: process.execPath,
    args: ['--import', 'tsx', 'src/index.ts'],
    cwd: appDirectory,
    env: {
      ...process.env,
      PORT: new URL(input.url).port,
      ORCA_RELAY_PUBLIC_URL: input.url,
      ORCA_RELAY_CELL_URL: input.url,
      ORCA_RELAY_CELL_ID: input.cellId,
      ORCA_RELAY_CELL_CAPACITY: '10',
      ORCA_RELAY_CELLS_JSON: JSON.stringify(input.cells ?? []),
      ORCA_RELAY_ROLE: input.role,
      ORCA_RELAY_AUTH_ISSUER: issuer,
      ORCA_RELAY_JWKS_URL: `${issuer}/jwks`,
      ORCA_RELAY_ASSIGNMENT_SIGNING_KEY: assignmentKey,
      ORCA_RELAY_DATA_DIR: input.dataDirectory,
      ORCA_RELAY_ADMIN_AUDIENCE: adminAudience,
      ORCA_RELAY_DEPLOY_SERVICE_ACCOUNT: 'deploy@example.com',
      ORCA_RELAY_MONITOR_SERVICE_ACCOUNT: 'monitor@example.com',
      ORCA_RELAY_FENCE_SERVICE_ACCOUNT: 'fence@example.com',
      ORCA_RELAY_FENCE_BROKER_SERVICE_ACCOUNT: 'broker@example.com',
      ORCA_RELAY_ADMIN_JWKS_URL: `${issuer}/jwks`
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolveMessage, reject) => {
    const cleanup = (): void => {
      socket.off('message', onMessage)
      socket.off('error', onError)
      socket.off('close', onClose)
    }
    const onMessage = (data: RawData): void => {
      cleanup()
      try {
        resolveMessage(JSON.parse(data.toString()) as Record<string, unknown>)
      } catch (error) {
        reject(error)
      }
    }
    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const onClose = (code: number, reason: Buffer): void => {
      cleanup()
      reject(new Error(`socket closed before message: ${code} ${reason.toString()}`))
    }
    socket.once('message', onMessage)
    socket.once('error', onError)
    socket.once('close', onClose)
  })
}

function nextRawMessage(socket: WebSocket): Promise<{ data: Buffer; binary: boolean }> {
  return new Promise((resolveMessage, reject) => {
    socket.once('message', (data, binary) =>
      resolveMessage({ data: Buffer.from(data as ArrayBuffer), binary })
    )
    socket.once('error', reject)
  })
}

function collectMessages(socket: WebSocket, count: number): Promise<Record<string, unknown>[]> {
  return new Promise((resolveMessages, reject) => {
    const messages: Record<string, unknown>[] = []
    const onMessage = (data: RawData): void => {
      try {
        messages.push(JSON.parse(data.toString()) as Record<string, unknown>)
        if (messages.length === count) {
          socket.off('message', onMessage)
          resolveMessages(messages)
        }
      } catch (error) {
        reject(error)
      }
    }
    socket.on('message', onMessage)
    socket.once('error', reject)
  })
}

async function attachPhone(input: {
  host: WebSocket
  hostAck: Record<string, unknown>
  hostId: string
  credential: string
}): Promise<{
  phone: WebSocket
  data: WebSocket
  connId: string
  hello: Record<string, unknown>
}> {
  const headers = forwardedHeaders()
  const phone = new WebSocket(`${relayUrl.replace('http:', 'ws:')}/v1/connect/${input.hostId}`, {
    headers
  })
  await new Promise<void>((resolveOpen, reject) => {
    phone.once('open', resolveOpen)
    phone.once('error', reject)
  })
  const connOpenPromise = nextMessage(input.host)
  phone.send(
    JSON.stringify({ type: 'relay-auth', v: 1, mode: 'connect', credential: input.credential })
  )
  const connOpen = await connOpenPromise
  expect(connOpen.type).toBe('conn-open')
  const connId = String(connOpen.connId)
  const data = new WebSocket(`${relayUrl.replace('http:', 'ws:')}/v1/host/data/${connId}`, {
    headers
  })
  await new Promise<void>((resolveOpen, reject) => {
    data.once('open', resolveOpen)
    data.once('error', reject)
  })
  const helloPromise = nextMessage(phone)
  data.send(
    JSON.stringify({
      type: 'host-data-auth',
      v: 1,
      connTicket: connOpen.connTicket,
      generation: input.hostAck.generation
    })
  )
  const hello = await helloPromise
  expect(hello).toMatchObject({ type: 'relay-hello', ok: true })
  return { phone, data, connId, hello }
}

async function openHostControl(input?: {
  controlResumeSecret?: string
  previousGeneration?: number
  keyPair?: nacl.BoxKeyPair
  assignmentEpoch?: number
  capabilities?: string
}): Promise<{ socket: WebSocket; ack: Record<string, unknown>; keyPair: nacl.BoxKeyPair }> {
  const keyPair = input?.keyPair ?? nacl.box.keyPair()
  const hostId = createHash('sha256').update(keyPair.publicKey).digest('base64url').slice(0, 16)
  const socket = new WebSocket(`${relayUrl.replace('http:', 'ws:')}/v1/host/control`, {
    headers: {
      authorization: `Bearer ${await relayToken('orca-relay', hostId)}`,
      ...(input?.capabilities ? { ['x-orca-host-capabilities']: input.capabilities } : {})
    },
    perMessageDeflate: false
  })
  await new Promise<void>((resolveOpen, reject) => {
    socket.once('open', resolveOpen)
    socket.once('error', reject)
  })
  socket.send(
    JSON.stringify({
      type: 'host-hello',
      v: 1,
      relayHostId: hostId,
      assignmentEpoch: input?.assignmentEpoch ?? 1,
      hostPublicKeyB64: Buffer.from(keyPair.publicKey).toString('base64'),
      appVersion: 'test',
      ...(input?.controlResumeSecret ? { controlResumeSecret: input.controlResumeSecret } : {}),
      ...(input?.previousGeneration === undefined
        ? {}
        : { previousGeneration: input.previousGeneration })
    })
  )
  const challenge = await nextMessage(socket)
  expect(challenge.type).toBe('host-challenge')
  const plaintext = nacl.box.open(
    Buffer.from(String(challenge.ciphertextB64), 'base64'),
    Buffer.from(String(challenge.nonceB64), 'base64'),
    Buffer.from(String(challenge.relayEphemeralPublicKeyB64), 'base64'),
    keyPair.secretKey
  )
  if (!plaintext) throw new Error('host challenge did not decrypt')
  const domain = new TextEncoder().encode(`${HOST_CHALLENGE_PLAINTEXT_DOMAIN}\0`)
  expect(plaintext.slice(0, domain.length)).toEqual(domain)
  const transcriptLength = new DataView(
    plaintext.buffer,
    plaintext.byteOffset + domain.length,
    4
  ).getUint32(0, false)
  const transcriptStart = domain.length + 4
  const transcript = plaintext.slice(transcriptStart, transcriptStart + transcriptLength)
  const secret = plaintext.slice(transcriptStart + transcriptLength)
  const proofB64 = createHmac('sha256', secret)
    .update(buildHostProofMacInput(transcript))
    .digest('base64')
  socket.send(
    JSON.stringify({
      type: 'host-challenge-ack',
      challengeId: challenge.challengeId,
      proofB64
    })
  )
  return { socket, ack: await nextMessage(socket), keyPair }
}

beforeAll(async () => {
  const keys = await generateKeyPair('ES256')
  privateKey = keys.privateKey
  const publicJwk = await exportJWK(keys.publicKey)
  const adminKeys = await generateKeyPair('RS256')
  adminPrivateKey = adminKeys.privateKey
  const adminPublicJwk = await exportJWK(adminKeys.publicKey)
  jwksServer = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(
      JSON.stringify({
        keys: [
          { ...publicJwk, kid: 'test-key', alg: 'ES256', use: 'sig' },
          { ...adminPublicJwk, kid: 'admin-key', alg: 'RS256', use: 'sig' }
        ]
      })
    )
  })
  await new Promise<void>((resolveListen) => jwksServer.listen(0, '127.0.0.1', resolveListen))
  const jwksAddress = jwksServer.address()
  if (!jwksAddress || typeof jwksAddress === 'string') throw new Error('missing JWKS address')
  issuer = `http://127.0.0.1:${jwksAddress.port}`
  const relayPort = await unusedPort()
  relayUrl = `http://127.0.0.1:${relayPort}`
  adminAudience = `${relayUrl}/v1/admin/drain`
  relayDataDirectory = mkdtempSync(resolve(tmpdir(), 'orca-relay-blackbox-'))
  relayProcess = spawnProcess({
    program: process.execPath,
    args: ['--import', 'tsx', 'src/index.ts'],
    cwd: appDirectory,
    env: {
      ...process.env,
      PORT: String(relayPort),
      ORCA_RELAY_PUBLIC_URL: relayUrl,
      ORCA_RELAY_CELL_URL: relayUrl,
      ORCA_RELAY_AUTH_ISSUER: issuer,
      ORCA_RELAY_JWKS_URL: `${issuer}/jwks`,
      ORCA_RELAY_ASSIGNMENT_SIGNING_KEY: assignmentKey,
      ORCA_RELAY_DATA_DIR: relayDataDirectory,
      ORCA_RELAY_ADMIN_AUDIENCE: adminAudience,
      ORCA_RELAY_DEPLOY_SERVICE_ACCOUNT: 'deploy@example.com',
      ORCA_RELAY_MONITOR_SERVICE_ACCOUNT: 'monitor@example.com',
      ORCA_RELAY_FENCE_SERVICE_ACCOUNT: 'fence@example.com',
      ORCA_RELAY_IMAGE_DIGEST: `sha256:${'a'.repeat(64)}`,
      ORCA_RELAY_ADMIN_JWKS_URL: `${issuer}/jwks`
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  await waitForRelay(relayProcess)
})

afterAll(async () => {
  await stopRelay(relayProcess, 'SIGTERM')
  await new Promise<void>((resolveClose) => jwksServer?.close(() => resolveClose()))
  rmSync(relayDataDirectory, { recursive: true, force: true })
})

describe('served relay URL', () => {
  it('restates a pending connection to the rebound control, detailed only when advertised', async () => {
    // Real upgrade must carry x-orca-host-capabilities into acceptControl; unit tests cannot catch a misspelled header here.
    const host = await openHostControl()
    const hostId = createHash('sha256')
      .update(host.keyPair.publicKey)
      .digest('base64url')
      .slice(0, 16)
    const inviteResponse = nextMessage(host.socket)
    host.socket.send(
      JSON.stringify({
        type: 'invite-create',
        reqId: 'capability-invite',
        relayDeviceId: 'capability-device'
      })
    )
    const invite = await inviteResponse
    const phone = new WebSocket(`${relayUrl.replace('http:', 'ws:')}/v1/connect/${hostId}`, {
      headers: forwardedHeaders()
    })
    await new Promise<void>((resolveOpen, reject) => {
      phone.once('open', resolveOpen)
      phone.once('error', reject)
    })
    const connectionPromise = nextMessage(host.socket)
    phone.send(
      JSON.stringify({ type: 'relay-auth', v: 1, mode: 'connect', credential: invite.inviteToken })
    )
    // Never attached: the connection stays pending, which is what the ack restates.
    const connection = await connectionPromise
    expect(connection.type).toBe('conn-open')

    const capable = await openHostControl({
      keyPair: host.keyPair,
      controlResumeSecret: String(host.ack.controlResumeSecret),
      previousGeneration: 1,
      capabilities: 'pending-conn-details'
    })
    expect(capable.ack.pendingConns).toEqual([
      {
        connId: connection.connId,
        connTicket: connection.connTicket,
        kind: 'invite',
        relayDeviceId: 'capability-device'
      }
    ])

    const legacy = await openHostControl({
      keyPair: host.keyPair,
      controlResumeSecret: String(capable.ack.controlResumeSecret),
      previousGeneration: 1
    })
    // Legacy hosts strictly decode entries; unadvertised fields would kill an otherwise healthy control.
    expect(legacy.ack.pendingConns).toEqual([
      { connId: connection.connId, connTicket: connection.connTicket }
    ])

    phone.close()
    legacy.socket.close()
  })

  it('keeps a pending attach usable after a bad ticket and rejects ticket replay', async () => {
    const host = await openHostControl()
    const hostId = createHash('sha256')
      .update(host.keyPair.publicKey)
      .digest('base64url')
      .slice(0, 16)
    const inviteResponse = nextMessage(host.socket)
    host.socket.send(
      JSON.stringify({
        type: 'invite-create',
        reqId: 'ticket-invite',
        relayDeviceId: 'ticket-device'
      })
    )
    const invite = await inviteResponse
    const phone = new WebSocket(`${relayUrl.replace('http:', 'ws:')}/v1/connect/${hostId}`, {
      headers: forwardedHeaders()
    })
    await new Promise<void>((resolveOpen, reject) => {
      phone.once('open', resolveOpen)
      phone.once('error', reject)
    })
    const connectionPromise = nextMessage(host.socket)
    phone.send(
      JSON.stringify({ type: 'relay-auth', v: 1, mode: 'connect', credential: invite.inviteToken })
    )
    const connection = await connectionPromise
    const dataUrl = `${relayUrl.replace('http:', 'ws:')}/v1/host/data/${connection.connId}`

    const badData = new WebSocket(dataUrl, { headers: forwardedHeaders() })
    await new Promise<void>((resolveOpen, reject) => {
      badData.once('open', resolveOpen)
      badData.once('error', reject)
    })
    const badClosed = new Promise<number>((resolveClose) =>
      badData.once('close', (code) => resolveClose(code))
    )
    badData.send(
      JSON.stringify({
        type: 'host-data-auth',
        v: 1,
        connTicket: Buffer.alloc(32, 1).toString('base64url'),
        generation: host.ack.generation
      })
    )
    expect(await badClosed).toBe(4401)

    const data = new WebSocket(dataUrl, { headers: forwardedHeaders() })
    await new Promise<void>((resolveOpen, reject) => {
      data.once('open', resolveOpen)
      data.once('error', reject)
    })
    const hello = nextMessage(phone)
    data.send(
      JSON.stringify({
        type: 'host-data-auth',
        v: 1,
        connTicket: connection.connTicket,
        generation: host.ack.generation
      })
    )
    expect(await hello).toMatchObject({ type: 'relay-hello', ok: true })

    const replay = new WebSocket(dataUrl, { headers: forwardedHeaders() })
    await new Promise<void>((resolveOpen, reject) => {
      replay.once('open', resolveOpen)
      replay.once('error', reject)
    })
    const replayClosed = new Promise<number>((resolveClose) =>
      replay.once('close', (code) => resolveClose(code))
    )
    replay.send(
      JSON.stringify({
        type: 'host-data-auth',
        v: 1,
        connTicket: connection.connTicket,
        generation: host.ack.generation
      })
    )
    expect(await replayClosed).toBe(4401)
    phone.close()
    data.close()
    host.socket.close()
  })

  it('attaches before success, preserves text/binary opcodes, installs, and confirms resume', async () => {
    const host = await openHostControl()
    const hostId = createHash('sha256')
      .update(host.keyPair.publicKey)
      .digest('base64url')
      .slice(0, 16)
    const invitePromise = nextMessage(host.socket)
    host.socket.send(
      JSON.stringify({ type: 'invite-create', reqId: 'invite-1', relayDeviceId: 'device-1' })
    )
    const invite = await invitePromise
    expect(invite.type).toBe('invite-created')
    const first = await attachPhone({
      host: host.socket,
      hostAck: host.ack,
      hostId,
      credential: String(invite.inviteToken)
    })

    const hostText = nextRawMessage(first.data)
    first.phone.send('phone-text')
    expect(await hostText).toEqual({ data: Buffer.from('phone-text'), binary: false })
    const phoneBinary = nextRawMessage(first.phone)
    first.data.send(Buffer.from([1, 2, 3]), { binary: true })
    expect(await phoneBinary).toEqual({ data: Buffer.from([1, 2, 3]), binary: true })

    const resumeToken = Buffer.alloc(32, 9).toString('base64url')
    const installedPromise = nextMessage(host.socket)
    host.socket.send(
      JSON.stringify({
        type: 'device-credential-install',
        v: 1,
        reqId: 'install-1',
        relayDeviceId: 'device-1',
        newResumeTokenHash: createHash('sha256').update(resumeToken).digest('base64url'),
        authorization: { mode: 'relay-basis', basisConnId: first.connId }
      })
    )
    const installed = await installedPromise
    expect(installed).toMatchObject({
      type: 'device-credential-installed',
      authorizationMode: 'relay-basis',
      currentVersion: 1
    })
    const resolved = await fetch(`${relayUrl}/v1/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, relayHostId: hostId, resumeToken })
    })
    expect(resolved.status).toBe(200)
    expect(await resolved.json()).toMatchObject({ v: 1, cellUrl: relayUrl, assignmentEpoch: 1 })
    first.phone.close()

    const resumed = await attachPhone({
      host: host.socket,
      hostAck: host.ack,
      hostId,
      credential: resumeToken
    })
    const confirmedPromise = nextMessage(host.socket)
    host.socket.send(
      JSON.stringify({
        type: 'device-resume-confirm',
        v: 1,
        reqId: 'confirm-1',
        basisConnId: resumed.connId
      })
    )
    expect(await confirmedPromise).toMatchObject({
      type: 'device-resume-confirmed',
      renewed: true,
      acceptedAs: 'current'
    })
    resumed.phone.close()
    resumed.data.close()
    host.socket.close()
  })

  it('serializes late direct and invite authorization modes into one served result', async () => {
    const host = await openHostControl()
    const hostId = createHash('sha256')
      .update(host.keyPair.publicKey)
      .digest('base64url')
      .slice(0, 16)
    const inviteResponse = nextMessage(host.socket)
    host.socket.send(
      JSON.stringify({ type: 'invite-create', reqId: 'race-invite', relayDeviceId: 'race-device' })
    )
    const invite = await inviteResponse
    const splice = await attachPhone({
      host: host.socket,
      hostAck: host.ack,
      hostId,
      credential: String(invite.inviteToken)
    })
    const responses = collectMessages(host.socket, 2)
    const base = {
      type: 'device-credential-install',
      v: 1,
      reqId: 'race-install',
      relayDeviceId: 'race-device',
      newResumeTokenHash: createHash('sha256').update('race-resume').digest('base64url')
    }
    host.socket.send(
      JSON.stringify({
        ...base,
        authorization: { mode: 'relay-basis', basisConnId: splice.connId }
      })
    )
    host.socket.send(
      JSON.stringify({
        ...base,
        authorization: { mode: 'authenticated-direct', directAuthId: 'late-direct' }
      })
    )
    const installed = await responses
    expect(installed).toHaveLength(2)
    expect(installed[0]).toEqual(installed[1])
    expect(installed[0]).toMatchObject({ type: 'device-credential-installed', currentVersion: 1 })
    splice.phone.close()
    splice.data.close()
    host.socket.close()
  })

  it('runs target-first dual-cell evacuation before releasing the source control', async () => {
    const originalUrl = relayUrl
    const dataDirectory = mkdtempSync(resolve(tmpdir(), 'orca-relay-topology-'))
    const directorUrl = `http://127.0.0.1:${await unusedPort()}`
    const cellAUrl = `http://127.0.0.1:${await unusedPort()}`
    const cellBUrl = `http://127.0.0.1:${await unusedPort()}`
    const cells = [
      { id: 'cell-a', url: cellAUrl, capacityRequests: 10 },
      { id: 'cell-b', url: cellBUrl, capacityRequests: 10 }
    ]
    const keyPair = nacl.box.keyPair()
    const hostId = createHash('sha256').update(keyPair.publicKey).digest('base64url').slice(0, 16)
    const seedDatabase = await openRelayDatabase({ dataDir: dataDirectory })
    const seedAssignments = new RelayAssignmentStore(seedDatabase)
    await seedAssignments.reconcileCells(cells)
    await seedAssignments.assign({ userId: 'user-1', relayHostId: hostId })
    await seedDatabase.close()

    const cellA = spawnTopologyRelay({
      url: cellAUrl,
      dataDirectory,
      role: 'cell',
      cellId: 'cell-a'
    })
    let director: ChildProcess | undefined
    let cellB: ChildProcess | undefined
    try {
      await waitForRelay(cellA)
      director = spawnTopologyRelay({
        url: directorUrl,
        dataDirectory,
        role: 'director',
        cellId: 'director',
        cells
      })
      await waitForRelay(director)
      expect(
        await fetch(`${directorUrl}/v1/admin/cell-heartbeat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}'
        })
      ).toMatchObject({ status: 401 })
      const heartbeatAudience = `${directorUrl}/v1/admin/cell-heartbeat`
      expect(
        await fetch(heartbeatAudience, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${await googleServiceToken(`${directorUrl}/wrong`)}`,
            'content-type': 'application/json'
          },
          body: '{}'
        })
      ).toMatchObject({ status: 401 })
      expect(
        await fetch(heartbeatAudience, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${await googleServiceToken(heartbeatAudience, 'wrong@example.com')}`,
            'content-type': 'application/json'
          },
          body: '{}'
        })
      ).toMatchObject({ status: 401 })
      expect(await postCellHeartbeat(directorUrl, cells[0]!, { startedAt: 1_000 })).toMatchObject({
        status: 200
      })
      expect(
        await postCellHeartbeat(directorUrl, cells[0]!, {
          incarnation: '33333333-3333-4333-8333-333333333333',
          startedAt: 999
        })
      ).toMatchObject({ status: 409 })
      expect(
        await postCellHeartbeat(directorUrl, cells[1]!, {
          incarnation: '22222222-2222-4222-8222-222222222222',
          startedAt: 2_000
        })
      ).toMatchObject({ status: 200 })
      relayUrl = cellAUrl
      const sourceHost = await openHostControl({ keyPair, assignmentEpoch: 1 })
      const token = await adminToken()
      const recoveryRequests = [
        {
          path: 'cell-fence-attempt-prepare',
          body: {
            v: 1,
            attemptId: '44444444-4444-4444-8444-444444444444',
            environment: 'production',
            cellId: 'cell-a',
            cellIncarnation: '11111111-1111-4111-8111-111111111111',
            migName: 'orca-relay-c1',
            instanceGroup: 'https://compute.example/instanceGroups/orca-relay-c1',
            generationIdentity: 'https://compute.example/instanceTemplates/orca-relay-c1-abc',
            fenceCommit: 'a'.repeat(40),
            planSha256: 'b'.repeat(64),
            planObjectName:
              'terraform/state/relay-fence-plans/production/44444444-4444-4444-8444-444444444444.tfplan',
            varFileSha256: 'c'.repeat(64),
            terraformStateLineage: 'c739dab4-e6e1-e627-02a9-504b3dda1a2c',
            terraformStateSerial: 7,
            terraformStateObjectGeneration: '987654321',
            terraformStateObjectSha256: 'd'.repeat(64),
            requestReason: 'orca-relay-fence/44444444-4444-4444-8444-444444444444'
          },
          confirmation: 'PREPARE_TERRAFORM_CELL_FENCE',
          expected: { status: 409, body: { error: 'cell_fence_admission_enabled' } }
        },
        {
          path: 'cell-fence-attempt-abort',
          body: {
            v: 1,
            attemptId: '44444444-4444-4444-8444-444444444444',
            environment: 'production',
            cellId: 'cell-a',
            cellIncarnation: '11111111-1111-4111-8111-111111111111',
            migName: 'orca-relay-c1',
            instanceGroup: 'https://compute.example/instanceGroups/orca-relay-c1',
            generationIdentity: 'https://compute.example/instanceTemplates/orca-relay-c1-abc',
            fenceCommit: 'a'.repeat(40),
            planSha256: 'b'.repeat(64),
            planObjectName:
              'terraform/state/relay-fence-plans/production/44444444-4444-4444-8444-444444444444.tfplan',
            varFileSha256: 'c'.repeat(64),
            terraformStateLineage: 'c739dab4-e6e1-e627-02a9-504b3dda1a2c',
            terraformStateSerial: 7,
            terraformStateObjectGeneration: '987654321',
            terraformStateObjectSha256: 'd'.repeat(64),
            requestReason: 'orca-relay-fence/44444444-4444-4444-8444-444444444444'
          },
          confirmation: 'ABORT_UNSTARTED_TERRAFORM_CELL_FENCE',
          expected: { status: 409, body: { error: 'cell_fence_attempt_not_found' } }
        },
        {
          path: 'migration-supersede-cell',
          body: {
            v: 1,
            sourceCellId: 'cell-a',
            currentTargetCellId: 'cell-b',
            replacementTargetCellId: 'cell-c',
            limit: 100
          },
          confirmation: 'SUPERSEDE_REGISTERED_CELL_MIGRATIONS',
          expected: { status: 200, body: { v: 1, superseded: 0 } }
        },
        {
          path: 'drain-attempt-prepare',
          body: {
            v: 1,
            attemptId: '55555555-5555-4555-8555-555555555555',
            cellId: 'cell-a',
            cellIncarnation: '11111111-1111-4111-8111-111111111111',
            traceValue: '66666666-6666-4666-8666-666666666666',
            graceMs: 120_000
          },
          confirmation: 'PREPARE_LEGACY_DRAIN',
          expected: { status: 409, body: { error: 'drain_attempt_admission_enabled' } }
        },
        {
          path: 'drain-attempt-recover-forward',
          body: {
            v: 1,
            cellId: 'cell-a',
            cellIncarnation: '11111111-1111-4111-8111-111111111111'
          },
          confirmation: 'RECOVER_LEGACY_DRAIN',
          expected: { status: 409, body: { error: 'drain_attempt_admission_enabled' } }
        }
      ]
      for (const request of recoveryRequests) {
        const url = `${directorUrl}/v1/admin/${request.path}`
        expect(
          await fetch(url, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify(request.body)
          })
        ).toMatchObject({ status: 400 })
        const confirmed = await fetch(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ ...request.body, confirmation: request.confirmation })
        })
        expect(confirmed.status).toBe(request.expected.status)
        expect(await confirmed.json()).toEqual(request.expected.body)
      }
      const statusUrl = `${directorUrl}/v1/admin/cell-status`
      expect(
        await fetch(statusUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ v: 1, cellId: 'cell-a' })
        })
      ).toMatchObject({ status: 401 })
      expect(
        await fetch(statusUrl, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ v: 1, cellId: 'cell-a', userId: 'must-not-be-accepted' })
        })
      ).toMatchObject({ status: 400 })
      const sourceStatusResponse = await fetch(statusUrl, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ v: 1, cellId: 'cell-a' })
      })
      expect(sourceStatusResponse.status).toBe(200)
      const sourceStatusText = await sourceStatusResponse.text()
      expect(sourceStatusText).not.toContain('user-1')
      expect(sourceStatusText).not.toContain(hostId)
      expect(JSON.parse(sourceStatusText)).toMatchObject({
        v: 1,
        status: {
          cellId: 'cell-a',
          cellUrl: cellAUrl,
          enabled: true,
          assignments: 1,
          activityLeases: 1,
          activityRequestUnits: 1,
          restartBlockingActivityLeases: 1,
          restartBlockingActivityRequestUnits: 1,
          restartBlockingReservedRequests: 1,
          runtime: { cellUrl: cellAUrl, ready: true, heartbeatFresh: true }
        }
      })
      const cellState = async (cellId: string, enabled: boolean): Promise<Response> =>
        await fetch(`${directorUrl}/v1/admin/cell-state`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ v: 1, cellId, enabled })
        })
      const configuredTarget = await fetch(`${directorUrl}/v1/admin/cell-config`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          v: 1,
          cellId: 'cell-b',
          cellUrl: cellBUrl,
          capacityRequests: 10,
          state: 'existing-only'
        })
      })
      expect(configuredTarget.status).toBe(200)
      expect(await configuredTarget.json()).toEqual({ ok: true })
      const incompleteLimit = await fetch(`${directorUrl}/v1/admin/cell-config`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          v: 1,
          cellId: 'cell-b',
          cellUrl: cellBUrl,
          capacityRequests: 10,
          connectionHardCap: 600,
          enabled: false
        })
      })
      expect(incompleteLimit.status).toBe(400)
      const capacity = await fetch(`${directorUrl}/v1/admin/evacuation-capacity`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ v: 1, sourceCellId: 'cell-a', targetCellId: 'cell-b' })
      })
      expect(capacity.status).toBe(200)
      expect(await capacity.json()).toEqual({
        v: 1,
        sourceAssignments: 1,
        requiredTargetUnits: 2,
        availableTargetUnits: 10
      })
      const disabledTarget = await fetch(`${directorUrl}/v1/admin/evacuate`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          v: 1,
          userId: 'user-1',
          relayHostId: hostId,
          targetCellId: 'cell-b'
        })
      })
      expect(disabledTarget.status).toBe(409)
      expect(await disabledTarget.json()).toEqual({ error: 'target_cell_unavailable' })
      expect((await cellState('cell-b', true)).status).toBe(200)
      const migrationResponse = await fetch(`${directorUrl}/v1/admin/evacuate-cell`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          v: 1,
          sourceCellId: 'cell-a',
          targetCellId: 'cell-b',
          limit: 10
        })
      })
      expect(migrationResponse.status).toBe(200)
      expect(await migrationResponse.json()).toEqual({ v: 1, started: 1 })
      const pendingStatus = await fetch(`${directorUrl}/v1/admin/evacuation-status`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          v: 1,
          sourceCellId: 'cell-a',
          targetCellId: 'cell-b'
        })
      })
      expect(pendingStatus.status).toBe(200)
      expect(await pendingStatus.json()).toMatchObject({
        v: 1,
        inProgress: 1,
        targetRegistered: 0,
        registeredSourceActive: 0,
        registeredCompletable: 0,
        registeredTargetInactive: 0,
        completed: 0,
        blocked: 0,
        expiredUnregistered: 0,
        repairableExpiredUnregistered: 0,
        abortableExpiredUnregistered: 0,
        blockedExpiredUnregistered: 0,
        blockedExpiredOnNewerTargetAssignment: 0
      })
      // Admin completion must prove source admission stopped despite its separate topology preflight.
      expect((await cellState('cell-a', false)).status).toBe(200)

      cellB = spawnTopologyRelay({
        url: cellBUrl,
        dataDirectory,
        role: 'cell',
        cellId: 'cell-b'
      })
      await waitForRelay(cellB)
      relayUrl = cellBUrl
      const targetHost = await openHostControl({ keyPair, assignmentEpoch: 2 })
      const completionBody = JSON.stringify({
        v: 1,
        sourceCellId: 'cell-a',
        targetCellId: 'cell-b',
        completeReady: true
      })
      const premature = await fetch(`${directorUrl}/v1/admin/evacuation-status`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: completionBody
      })
      expect(premature.status).toBe(200)
      expect(await premature.json()).toMatchObject({
        v: 1,
        inProgress: 1,
        targetRegistered: 1,
        registeredSourceActive: 1,
        registeredCompletable: 0,
        registeredTargetInactive: 0,
        completed: 0,
        blocked: 1,
        expiredUnregistered: 0,
        repairableExpiredUnregistered: 0,
        abortableExpiredUnregistered: 0,
        blockedExpiredUnregistered: 0,
        blockedExpiredOnNewerTargetAssignment: 0
      })

      const sourceClosed = new Promise<number>((resolveClose) =>
        sourceHost.socket.once('close', (code) => resolveClose(code))
      )
      const drain = await fetch(`${cellAUrl}/v1/admin/drain`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ v: 1, graceMs: 0 })
      })
      expect(drain.status).toBe(200)
      expect(await sourceClosed).toBe(4503)

      let completed: Response | undefined
      for (let attempt = 0; attempt < 20; attempt++) {
        completed = await fetch(`${directorUrl}/v1/admin/evacuation-status`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: completionBody
        })
        if (
          completed.status === 200 &&
          ((await completed.clone().json()) as { inProgress?: number }).inProgress === 0
        ) {
          break
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 10))
      }
      expect(completed?.status).toBe(200)
      expect(await completed?.json()).toMatchObject({
        v: 1,
        inProgress: 0,
        targetRegistered: 0,
        registeredSourceActive: 0,
        registeredCompletable: 0,
        registeredTargetInactive: 0,
        completed: 1,
        blocked: 0,
        expiredUnregistered: 0,
        repairableExpiredUnregistered: 0,
        abortableExpiredUnregistered: 0,
        blockedExpiredUnregistered: 0,
        blockedExpiredOnNewerTargetAssignment: 0
      })
      const observedDatabase = await openRelayDatabase({ dataDir: dataDirectory })
      const assignment = await new RelayAssignmentStore(observedDatabase).resolve({
        userId: 'user-1',
        relayHostId: hostId
      })
      const reservations = await observedDatabase.query(
        `SELECT cell_id, reserved_requests FROM relay_cells ORDER BY cell_id`
      )
      await observedDatabase.close()
      expect(assignment).toMatchObject({ cellId: 'cell-b', assignmentEpoch: 2 })
      expect(reservations).toEqual([
        { cell_id: 'cell-a', reserved_requests: 0 },
        { cell_id: 'cell-b', reserved_requests: 1 }
      ])
      const selectorStatusBefore = await fetch(
        `${directorUrl}/v1/admin/admission-selector/status`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({ v: 1 })
        }
      )
      expect(selectorStatusBefore.status).toBe(200)
      const selectorBefore = (await selectorStatusBefore.json()) as {
        selector: { membership: CellAdmissionMembership }
      }
      const selectorInput = {
        v: 1,
        attemptId: 'blackbox_cutover',
        expectedGeneration: 0,
        expectedMembershipSha256: createHash('sha256')
          .update(encodeMembership(selectorBefore.selector.membership))
          .digest('hex'),
        membership: {
          existingOnly: ['cell-a'],
          migrationOnly: [],
          general: ['cell-b']
        }
      }
      const unsafeSelectorInput = { ...selectorInput, expectedMembershipSha256: undefined }
      const unsafeSelectorResponse = await fetch(
        `${directorUrl}/v1/admin/admission-selector/apply`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify(unsafeSelectorInput)
        }
      )
      expect(unsafeSelectorResponse.status).toBe(400)
      const selectorResponse = await fetch(`${directorUrl}/v1/admin/admission-selector/apply`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify(selectorInput)
      })
      expect(selectorResponse.status).toBe(200)
      expect(await selectorResponse.json()).toMatchObject({
        v: 1,
        changed: true,
        selector: { generation: 1, membership: selectorInput.membership }
      })
      const selectorStatus = await fetch(`${directorUrl}/v1/admin/admission-selector/status`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ v: 1, attemptId: selectorInput.attemptId })
      })
      expect(selectorStatus.status).toBe(200)
      expect(await selectorStatus.json()).toMatchObject({
        v: 1,
        selector: { generation: 1, membership: selectorInput.membership },
        intent: { attemptId: selectorInput.attemptId, state: 'committed' }
      })
      const addCellsInput = {
        v: 1,
        attemptId: 'blackbox_add_cells',
        expectedGeneration: 1,
        cells: [
          {
            cellId: 'cell-c',
            cellUrl: 'https://relay-c.example.com',
            capacityRequests: 20,
            connectionHardCap: 1_000,
            connectionUnobservedBound: 60
          }
        ]
      }
      const addCellsResponse = await fetch(
        `${directorUrl}/v1/admin/admission-selector/add-migration-cells`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify(addCellsInput)
        }
      )
      expect(addCellsResponse.status).toBe(200)
      expect(await addCellsResponse.json()).toMatchObject({
        v: 1,
        changed: true,
        selector: {
          generation: 2,
          membership: {
            existingOnly: ['cell-a'],
            migrationOnly: ['cell-c'],
            general: ['cell-b']
          }
        }
      })
      expect((await cellState('cell-a', true)).status).toBe(409)
      targetHost.socket.close()
    } finally {
      for (const child of [cellA, cellB, director]) {
        await stopRelay(child)
      }
      relayUrl = originalUrl
      rmSync(dataDirectory, { recursive: true, force: true })
    }
  })

  it('recovers an unexpired invite through a restarted configured director without reservation', async () => {
    const combinedUrl = relayUrl
    const host = await openHostControl()
    const hostId = createHash('sha256')
      .update(host.keyPair.publicKey)
      .digest('base64url')
      .slice(0, 16)
    const invitePromise = nextMessage(host.socket)
    host.socket.send(
      JSON.stringify({ type: 'invite-create', reqId: 'move-invite', relayDeviceId: 'move-device' })
    )
    const invite = await invitePromise
    host.socket.close()

    await stopRelay(relayProcess, 'SIGKILL')
    const directorPort = await unusedPort()
    relayUrl = `http://127.0.0.1:${directorPort}`
    relayProcess = spawnProcess({
      program: process.execPath,
      args: ['--import', 'tsx', 'src/index.ts'],
      cwd: appDirectory,
      env: {
        ...process.env,
        PORT: String(directorPort),
        ORCA_RELAY_PUBLIC_URL: relayUrl,
        ORCA_RELAY_CELL_URL: 'https://relay-c2.onorca.dev',
        ORCA_RELAY_AUTH_ISSUER: issuer,
        ORCA_RELAY_JWKS_URL: `${issuer}/jwks`,
        ORCA_RELAY_ASSIGNMENT_SIGNING_KEY: assignmentKey,
        ORCA_RELAY_DATA_DIR: relayDataDirectory,
        ORCA_RELAY_ROLE: 'director',
        ORCA_RELAY_CELLS_JSON: JSON.stringify([
          {
            id: 'cell-c2',
            url: 'https://relay-c2.onorca.dev',
            capacityRequests: 900
          }
        ]),
        ORCA_RELAY_ADMIN_AUDIENCE: adminAudience,
        ORCA_RELAY_DEPLOY_SERVICE_ACCOUNT: 'deploy@example.com',
        ORCA_RELAY_ADMIN_JWKS_URL: `${issuer}/jwks`
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    await waitForRelay(relayProcess)
    expect(
      await postCellHeartbeat(relayUrl, {
        id: 'cell-c2',
        url: 'https://relay-c2.onorca.dev'
      })
    ).toMatchObject({ status: 200 })

    const phone = new WebSocket(`${relayUrl.replace('http:', 'ws:')}/v1/connect/${hostId}`, {
      headers: forwardedHeaders()
    })
    await new Promise<void>((resolveOpen) => phone.once('open', resolveOpen))
    const movedPromise = nextMessage(phone)
    const closed = new Promise<number>((resolveClose) =>
      phone.once('close', (code) => resolveClose(code))
    )
    phone.send(
      JSON.stringify({
        type: 'relay-auth',
        v: 1,
        mode: 'connect',
        credential: invite.inviteToken
      })
    )
    expect(await movedPromise).toEqual({
      type: 'relay-moved',
      v: 1,
      cellUrl: 'https://relay-c2.onorca.dev',
      assignmentEpoch: 1
    })
    expect(await closed).toBe(4503)

    await stopRelay(relayProcess, 'SIGTERM')
    relayUrl = combinedUrl
    relayProcess = spawnProcess({
      program: process.execPath,
      args: ['--import', 'tsx', 'src/index.ts'],
      cwd: appDirectory,
      env: {
        ...process.env,
        PORT: new URL(combinedUrl).port,
        ORCA_RELAY_PUBLIC_URL: combinedUrl,
        ORCA_RELAY_CELL_URL: combinedUrl,
        ORCA_RELAY_AUTH_ISSUER: issuer,
        ORCA_RELAY_JWKS_URL: `${issuer}/jwks`,
        ORCA_RELAY_ASSIGNMENT_SIGNING_KEY: assignmentKey,
        ORCA_RELAY_DATA_DIR: relayDataDirectory,
        ORCA_RELAY_ADMIN_AUDIENCE: adminAudience,
        ORCA_RELAY_DEPLOY_SERVICE_ACCOUNT: 'deploy@example.com',
        ORCA_RELAY_CAPACITY_SERVICE_ACCOUNT: 'capacity@example.com',
        ORCA_RELAY_MONITOR_SERVICE_ACCOUNT: 'monitor@example.com',
        ORCA_RELAY_FENCE_SERVICE_ACCOUNT: 'fence@example.com',
        ORCA_RELAY_IMAGE_DIGEST: `sha256:${'a'.repeat(64)}`,
        ORCA_RELAY_ADMIN_JWKS_URL: `${issuer}/jwks`
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    await waitForRelay(relayProcess)
  })

  it('uses configured-director recovery and typed 4503 on unplanned SIGTERM', async () => {
    const originalUrl = relayUrl
    const signalPort = await unusedPort()
    const signalUrl = `http://127.0.0.1:${signalPort}`
    const signalData = mkdtempSync(resolve(tmpdir(), 'orca-relay-sigterm-'))
    const signalProcess = spawnProcess({
      program: process.execPath,
      args: ['--import', 'tsx', 'src/index.ts'],
      cwd: appDirectory,
      env: {
        ...process.env,
        PORT: String(signalPort),
        ORCA_RELAY_PUBLIC_URL: signalUrl,
        ORCA_RELAY_CELL_URL: signalUrl,
        ORCA_RELAY_AUTH_ISSUER: issuer,
        ORCA_RELAY_JWKS_URL: `${issuer}/jwks`,
        ORCA_RELAY_ASSIGNMENT_SIGNING_KEY: assignmentKey,
        ORCA_RELAY_DATA_DIR: signalData,
        ORCA_RELAY_ADMIN_AUDIENCE: adminAudience,
        ORCA_RELAY_DEPLOY_SERVICE_ACCOUNT: 'deploy@example.com',
        ORCA_RELAY_ADMIN_JWKS_URL: `${issuer}/jwks`
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    relayUrl = signalUrl
    try {
      await waitForRelay(signalProcess)
      const host = await openHostControl()
      const drain = nextMessage(host.socket)
      const closed = new Promise<number>((resolveClose) =>
        host.socket.once('close', (code) => resolveClose(code))
      )
      const exited = new Promise<void>((resolveExit) =>
        signalProcess.once('exit', () => resolveExit())
      )
      signalProcess.kill('SIGTERM')
      expect(await drain).toEqual({
        type: 'drain',
        graceMs: 0,
        recovery: 'resolve-director'
      })
      expect(await closed).toBe(4503)
      await exited
    } finally {
      await stopRelay(signalProcess)
      relayUrl = originalUrl
      rmSync(signalData, { recursive: true, force: true })
    }
  })
})
