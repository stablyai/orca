import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose'
import {
  buildHostProofMacInput,
  HOST_CHALLENGE_PLAINTEXT_DOMAIN
} from '@orca-cloud/relay-contract'
import nacl from 'tweetnacl'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import type { RawData } from 'ws'
import { RelayAssignmentStore } from './assignment-store.js'
import {
  encodeMembership,
  type CellAdmissionMembership
} from './cell-admission-selector.js'
import { openRelayDatabase } from './database.js'

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

async function waitForRelay(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolveReady, reject) => {
    let stderr = ''
    const timeout = setTimeout(() => reject(new Error('relay did not start')), 10_000)
    child.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('[orca-relay] listening')) {
        clearTimeout(timeout)
        resolveReady()
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.once('exit', (code) =>
      reject(new Error(`relay exited before ready: ${code}\n${stderr}`))
    )
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
  return spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
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

async function installDirectCredential(input: {
  host: WebSocket
  relayDeviceId: string
  reqId: string
  resumeToken: string
}): Promise<Record<string, unknown>> {
  const response = nextMessage(input.host)
  input.host.send(
    JSON.stringify({
      type: 'device-credential-install',
      v: 1,
      reqId: input.reqId,
      relayDeviceId: input.relayDeviceId,
      newResumeTokenHash: createHash('sha256').update(input.resumeToken).digest('base64url'),
      authorization: { mode: 'authenticated-direct', directAuthId: `direct-${input.reqId}` }
    })
  )
  return await response
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
  phone.send(JSON.stringify({ type: 'relay-auth', v: 1, mode: 'connect', credential: input.credential }))
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
}): Promise<{ socket: WebSocket; ack: Record<string, unknown>; keyPair: nacl.BoxKeyPair }> {
  const keyPair = input?.keyPair ?? nacl.box.keyPair()
  const hostId = createHash('sha256').update(keyPair.publicKey).digest('base64url').slice(0, 16)
  const socket = new WebSocket(`${relayUrl.replace('http:', 'ws:')}/v1/host/control`, {
    headers: { authorization: `Bearer ${await relayToken('orca-relay', hostId)}` },
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
      ...(input?.controlResumeSecret
        ? { controlResumeSecret: input.controlResumeSecret }
        : {}),
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
  relayProcess = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
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
  relayProcess?.kill('SIGTERM')
  await new Promise<void>((resolveClose) => jwksServer?.close(() => resolveClose()))
  rmSync(relayDataDirectory, { recursive: true, force: true })
})

describe('served relay URL', () => {
  it('exposes only /health, never /healthz', async () => {
    expect(await (await fetch(`${relayUrl}/health`)).json()).toEqual({
      ok: true,
      connectionCapacityProtocol: 2
    })
    expect(await (await fetch(`${relayUrl}/ready`)).json()).toEqual({ ok: true })
    expect((await fetch(`${relayUrl}/healthz`)).status).toBe(404)
  })

  it('keeps liveness healthy when dependency readiness fails', async () => {
    const port = await unusedPort()
    const url = `http://127.0.0.1:${port}`
    const dataDirectory = mkdtempSync(resolve(tmpdir(), 'orca-relay-unready-'))
    const processUnderTest = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: appDirectory,
      env: {
        ...process.env,
        PORT: String(port),
        ORCA_RELAY_PUBLIC_URL: url,
        ORCA_RELAY_CELL_URL: url,
        ORCA_RELAY_AUTH_ISSUER: issuer,
        ORCA_RELAY_JWKS_URL: 'http://127.0.0.1:1/jwks',
        ORCA_RELAY_ASSIGNMENT_SIGNING_KEY: assignmentKey,
        ORCA_RELAY_DATA_DIR: dataDirectory,
        ORCA_RELAY_ADMIN_AUDIENCE: adminAudience,
        ORCA_RELAY_DEPLOY_SERVICE_ACCOUNT: 'deploy@example.com',
        ORCA_RELAY_IMAGE_DIGEST: `sha256:${'a'.repeat(64)}`,
        ORCA_RELAY_ADMIN_JWKS_URL: `${issuer}/jwks`
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    try {
      await waitForRelay(processUnderTest)
      expect((await fetch(`${url}/health`)).status).toBe(200)
      expect((await fetch(`${url}/ready`)).status).toBe(503)
    } finally {
      processUnderTest.kill('SIGTERM')
      await new Promise<void>((resolveExit) => processUnderTest.once('exit', () => resolveExit()))
      rmSync(dataDirectory, { recursive: true, force: true })
    }
  })

  it('rejects missing and broad-audience bearer tokens', async () => {
    const body = JSON.stringify({ v: 1, relayHostId: 'abcdefghijklmnop' })
    expect((await fetch(`${relayUrl}/v1/assign`, { method: 'POST', body })).status).toBe(401)
    expect(
      (
        await fetch(`${relayUrl}/v1/assign`, {
          method: 'POST',
          headers: { authorization: `Bearer ${await relayToken('orca-cloud')}` },
          body
        })
      ).status
    ).toBe(401)
  })

  it('bounds slow first-frame admission and rejects URL credentials before upgrade', async () => {
    const slow: WebSocket[] = []
    for (let index = 0; index < 4; index++) {
      const socket = new WebSocket(
        `${relayUrl.replace('http:', 'ws:')}/v1/connect/abcdefghijklmnop`
      )
      await new Promise<void>((resolveOpen, reject) => {
        socket.once('open', resolveOpen)
        socket.once('error', reject)
      })
      slow.push(socket)
    }
    const limited = new WebSocket(
      `${relayUrl.replace('http:', 'ws:')}/v1/connect/abcdefghijklmnop`
    )
    const limitedStatus = await new Promise<number>((resolveStatus) => {
      limited.once('unexpected-response', (_request, response) =>
        resolveStatus(response.statusCode ?? 0)
      )
      limited.once('error', () => {})
    })
    expect(limitedStatus).toBe(429)
    const isolated = new WebSocket(
      `${relayUrl.replace('http:', 'ws:')}/v1/connect/abcdefghijklmnop`,
      { headers: { 'x-forwarded-for': 'spoofed, 198.51.100.9, 35.191.0.1' } }
    )
    await new Promise<void>((resolveOpen, reject) => {
      isolated.once('open', resolveOpen)
      isolated.once('error', reject)
    })
    isolated.close()
    for (const socket of slow) socket.close()

    const leaked = new WebSocket(
      `${relayUrl.replace('http:', 'ws:')}/v1/connect/abcdefghijklmnop?credential=secret`
    )
    const leakedStatus = await new Promise<number>((resolveStatus) => {
      leaked.once('unexpected-response', (_request, response) =>
        resolveStatus(response.statusCode ?? 0)
      )
      leaked.once('error', () => {})
    })
    expect(leakedStatus).toBe(400)
  })

  it('enforces process-wide slow-auth and per-source rate budgets', async () => {
    const slow: WebSocket[] = []
    for (let index = 0; index < 45; index++) {
      const socket = new WebSocket(
        `${relayUrl.replace('http:', 'ws:')}/v1/connect/abcdefghijklmnop`,
        { headers: { 'x-forwarded-for': `spoofed, 198.51.100.${index + 1}, 35.191.0.1` } }
      )
      await new Promise<void>((resolveOpen, reject) => {
        socket.once('open', resolveOpen)
        socket.once('error', reject)
      })
      slow.push(socket)
    }
    const globallyLimited = new WebSocket(
      `${relayUrl.replace('http:', 'ws:')}/v1/connect/abcdefghijklmnop`,
      { headers: { 'x-forwarded-for': 'spoofed, 203.0.113.1, 35.191.0.1' } }
    )
    const globalStatus = await new Promise<number>((resolveStatus) => {
      globallyLimited.once('unexpected-response', (_request, response) =>
        resolveStatus(response.statusCode ?? 0)
      )
      globallyLimited.once('error', () => {})
    })
    expect(globalStatus).toBe(429)
    await Promise.all(
      slow.map(
        (socket) =>
          new Promise<void>((resolveClose) => {
            socket.once('close', () => resolveClose())
            socket.close()
          })
      )
    )

    for (let index = 0; index < 30; index++) {
      const socket = new WebSocket(
        `${relayUrl.replace('http:', 'ws:')}/v1/connect/abcdefghijklmnop`,
        { headers: { 'x-forwarded-for': 'spoofed, 203.0.113.2, 35.191.0.1' } }
      )
      await new Promise<void>((resolveOpen, reject) => {
        socket.once('open', resolveOpen)
        socket.once('error', reject)
      })
      const closed = new Promise<void>((resolveClose) => socket.once('close', () => resolveClose()))
      socket.send('{}')
      await closed
    }
    const rateLimited = new WebSocket(
      `${relayUrl.replace('http:', 'ws:')}/v1/connect/abcdefghijklmnop`,
      { headers: { 'x-forwarded-for': 'spoofed, 203.0.113.2, 35.191.0.1' } }
    )
    const rateStatus = await new Promise<number>((resolveStatus) => {
      rateLimited.once('unexpected-response', (_request, response) =>
        resolveStatus(response.statusCode ?? 0)
      )
      rateLimited.once('error', () => {})
    })
    expect(rateStatus).toBe(429)
  })

  it('returns a signed combined-service assignment for the bound host', async () => {
    const response = await fetch(`${relayUrl}/v1/assign`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await relayToken('orca-relay')}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ v: 1, relayHostId: 'abcdefghijklmnop' })
    })
    expect(response.status).toBe(200)
    const assignment = (await response.json()) as {
      v: number
      cellUrl: string
      assignmentEpoch: number
      lease: string
    }
    expect(assignment).toMatchObject({ v: 1, cellUrl: relayUrl, assignmentEpoch: 1 })
    const verified = await jwtVerify(assignment.lease, new TextEncoder().encode(assignmentKey), {
      issuer: relayUrl,
      audience: 'orca-relay-cell',
      algorithms: ['HS256']
    })
    expect(verified.payload).toMatchObject({ relayHostId: 'abcdefghijklmnop' })
  })

  it('requires canonical host key possession and supports same-generation rebind', async () => {
    const first = await openHostControl()
    expect(first.ack).toMatchObject({ type: 'host-hello-ack', v: 1, generation: 1 })
    const firstClose = new Promise<number>((resolveClose) =>
      first.socket.once('close', (code) => resolveClose(code))
    )
    const rebound = await openHostControl({
      keyPair: first.keyPair,
      controlResumeSecret: String(first.ack.controlResumeSecret),
      previousGeneration: 1
    })
    expect(rebound.ack).toMatchObject({ type: 'host-hello-ack', v: 1, generation: 1 })
    expect(await firstClose).toBe(4408)
    rebound.socket.close()
  })

  it('rejects a scoped token presented by a different host key', async () => {
    const claimedKey = nacl.box.keyPair()
    const wrongKey = nacl.box.keyPair()
    const hostId = createHash('sha256').update(claimedKey.publicKey).digest('base64url').slice(0, 16)
    const socket = new WebSocket(`${relayUrl.replace('http:', 'ws:')}/v1/host/control`, {
      headers: { authorization: `Bearer ${await relayToken('orca-relay', hostId)}` }
    })
    await new Promise<void>((resolveOpen) => socket.once('open', resolveOpen))
    const closed = new Promise<number>((resolveClose) =>
      socket.once('close', (code) => resolveClose(code))
    )
    socket.send(
      JSON.stringify({
        type: 'host-hello',
        v: 1,
        relayHostId: hostId,
        assignmentEpoch: 1,
        hostPublicKeyB64: Buffer.from(wrongKey.publicKey).toString('base64'),
        appVersion: 'test'
      })
    )
    expect(await closed).toBe(4401)
  })

  it('returns typed 4409 without a cell URL for a stale assignment epoch', async () => {
    const keyPair = nacl.box.keyPair()
    const hostId = createHash('sha256').update(keyPair.publicKey).digest('base64url').slice(0, 16)
    const socket = new WebSocket(`${relayUrl.replace('http:', 'ws:')}/v1/host/control`, {
      headers: { authorization: `Bearer ${await relayToken('orca-relay', hostId)}` }
    })
    await new Promise<void>((resolveOpen, reject) => {
      socket.once('open', resolveOpen)
      socket.once('error', reject)
    })
    const closed = new Promise<{ code: number; reason: string }>((resolveClose) =>
      socket.once('close', (code, reason) =>
        resolveClose({ code, reason: reason.toString() })
      )
    )
    socket.send(
      JSON.stringify({
        type: 'host-hello',
        v: 1,
        relayHostId: hostId,
        assignmentEpoch: 2,
        hostPublicKeyB64: Buffer.from(keyPair.publicKey).toString('base64'),
        appVersion: 'test'
      })
    )
    const result = await closed
    expect(result.code).toBe(4409)
    expect(result.reason).not.toContain('http')
  })

  it('keeps a pending attach usable after a bad ticket and rejects ticket replay', async () => {
    const host = await openHostControl()
    const hostId = createHash('sha256')
      .update(host.keyPair.publicKey)
      .digest('base64url')
      .slice(0, 16)
    const inviteResponse = nextMessage(host.socket)
    host.socket.send(
      JSON.stringify({ type: 'invite-create', reqId: 'ticket-invite', relayDeviceId: 'ticket-device' })
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

  it('does not renew outer-only or injected confirmations and reports offline/peer loss', async () => {
    const host = await openHostControl()
    const hostId = createHash('sha256')
      .update(host.keyPair.publicKey)
      .digest('base64url')
      .slice(0, 16)
    const resumeToken = Buffer.alloc(32, 11).toString('base64url')
    expect(
      await installDirectCredential({
        host: host.socket,
        relayDeviceId: 'outer-device',
        reqId: 'outer-install',
        resumeToken
      })
    ).toMatchObject({ type: 'device-credential-installed', currentVersion: 1 })

    const first = await attachPhone({ host: host.socket, hostAck: host.ack, hostId, credential: resumeToken })
    const originalExpiry = first.hello.resumeExpiresAt
    first.phone.close()
    first.data.close()
    await new Promise((resolveWait) => setTimeout(resolveWait, 25))
    const closedBasis = nextMessage(host.socket)
    host.socket.send(
      JSON.stringify({
        type: 'device-resume-confirm',
        v: 1,
        reqId: 'closed-basis-confirm',
        basisConnId: first.connId
      })
    )
    expect(await closedBasis).toMatchObject({
      type: 'control-error',
      reqId: 'closed-basis-confirm',
      code: 'confirmation_not_active'
    })
    const second = await attachPhone({ host: host.socket, hostAck: host.ack, hostId, credential: resumeToken })
    expect(second.hello.resumeExpiresAt).toBe(originalExpiry)
    const injectedResult = nextMessage(host.socket)
    host.socket.send(
      JSON.stringify({
        type: 'device-resume-confirm',
        v: 1,
        reqId: 'injected-confirm',
        basisConnId: second.connId,
        relayDeviceId: 'injected',
        acceptedCredentialVersion: 99
      })
    )
    expect(await injectedResult).toMatchObject({ type: 'control-error', reqId: 'injected-confirm' })
    const phoneClosed = new Promise<number>((resolveClose) =>
      second.phone.once('close', (code) => resolveClose(code))
    )
    second.data.close()
    expect(await phoneClosed).toBe(4408)

    await new Promise<void>((resolveClose) => {
      host.socket.once('close', () => resolveClose())
      host.socket.close()
    })
    const offline = new WebSocket(`${relayUrl.replace('http:', 'ws:')}/v1/connect/${hostId}`, {
      headers: forwardedHeaders()
    })
    await new Promise<void>((resolveOpen) => offline.once('open', resolveOpen))
    const offlineHello = nextMessage(offline)
    offline.send(
      JSON.stringify({ type: 'relay-auth', v: 1, mode: 'connect', credential: resumeToken })
    )
    expect(await offlineHello).toEqual({ type: 'relay-hello', ok: false, code: 4404 })
  })

  it('rejects the first post-E2EE confirmation after its server-owned deadline', async () => {
    const originalUrl = relayUrl
    const clockPort = await unusedPort()
    const clockUrl = `http://127.0.0.1:${clockPort}`
    const clockData = mkdtempSync(resolve(tmpdir(), 'orca-relay-clock-'))
    const clockFile = resolve(clockData, 'offset-ms')
    writeFileSync(clockFile, '0')
    const clockProcess = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/fault-injection-test-entry.ts'],
      {
        cwd: appDirectory,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          PORT: String(clockPort),
          ORCA_RELAY_PUBLIC_URL: clockUrl,
          ORCA_RELAY_CELL_URL: clockUrl,
          ORCA_RELAY_AUTH_ISSUER: issuer,
          ORCA_RELAY_JWKS_URL: `${issuer}/jwks`,
          ORCA_RELAY_ASSIGNMENT_SIGNING_KEY: assignmentKey,
          ORCA_RELAY_DATA_DIR: clockData,
          ORCA_RELAY_ADMIN_AUDIENCE: adminAudience,
          ORCA_RELAY_DEPLOY_SERVICE_ACCOUNT: 'deploy@example.com',
          ORCA_RELAY_ADMIN_JWKS_URL: `${issuer}/jwks`,
          ORCA_RELAY_TEST_CLOCK_FILE: clockFile
        },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    relayUrl = clockUrl
    try {
      await waitForRelay(clockProcess)
      const host = await openHostControl()
      const hostId = createHash('sha256')
        .update(host.keyPair.publicKey)
        .digest('base64url')
        .slice(0, 16)
      const resumeToken = Buffer.alloc(32, 25).toString('base64url')
      await installDirectCredential({
        host: host.socket,
        relayDeviceId: 'late-confirm-device',
        reqId: 'late-confirm-install',
        resumeToken
      })
      const splice = await attachPhone({
        host: host.socket,
        hostAck: host.ack,
        hostId,
        credential: resumeToken
      })
      writeFileSync(clockFile, '31000')
      const rejected = nextMessage(host.socket)
      host.socket.send(
        JSON.stringify({
          type: 'device-resume-confirm',
          v: 1,
          reqId: 'late-first-confirm',
          basisConnId: splice.connId
        })
      )
      expect(await rejected).toMatchObject({
        type: 'control-error',
        reqId: 'late-first-confirm',
        code: 'confirmation_not_active'
      })
      splice.phone.close()
      splice.data.close()
      host.socket.close()
    } finally {
      clockProcess.kill('SIGKILL')
      await new Promise<void>((resolveExit) => clockProcess.once('exit', () => resolveExit()))
      relayUrl = originalUrl
      rmSync(clockData, { recursive: true, force: true })
    }
  })

  it('fences a competing generation and rejects its old immutable basis', async () => {
    const firstHost = await openHostControl()
    const hostId = createHash('sha256')
      .update(firstHost.keyPair.publicKey)
      .digest('base64url')
      .slice(0, 16)
    const resumeToken = Buffer.alloc(32, 12).toString('base64url')
    await installDirectCredential({
      host: firstHost.socket,
      relayDeviceId: 'fenced-device',
      reqId: 'fenced-install',
      resumeToken
    })
    const splice = await attachPhone({
      host: firstHost.socket,
      hostAck: firstHost.ack,
      hostId,
      credential: resumeToken
    })
    const replacement = await openHostControl({ keyPair: firstHost.keyPair, previousGeneration: 1 })
    expect(replacement.ack.generation).toBe(2)
    const rejected = nextMessage(replacement.socket)
    replacement.socket.send(
      JSON.stringify({
        type: 'device-resume-confirm',
        v: 1,
        reqId: 'wrong-generation-confirm',
        basisConnId: splice.connId
      })
    )
    expect(await rejected).toMatchObject({
      type: 'control-error',
      reqId: 'wrong-generation-confirm',
      code: 'confirmation_not_active'
    })
    replacement.socket.close()
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

  it('reconciles a direct commit after its response is ignored and rejects bad authorization', async () => {
    const firstHost = await openHostControl()
    const hostId = createHash('sha256')
      .update(firstHost.keyPair.publicKey)
      .digest('base64url')
      .slice(0, 16)
    const inviteResponse = nextMessage(firstHost.socket)
    firstHost.socket.send(
      JSON.stringify({
        type: 'invite-create',
        reqId: 'lost-response-invite',
        relayDeviceId: 'lost-response-device'
      })
    )
    const invite = await inviteResponse
    const resumeToken = Buffer.alloc(32, 26).toString('base64url')
    firstHost.socket.send(
      JSON.stringify({
        type: 'device-credential-install',
        v: 1,
        reqId: 'lost-response-install',
        relayDeviceId: 'lost-response-device',
        newResumeTokenHash: createHash('sha256').update(resumeToken).digest('base64url'),
        authorization: { mode: 'authenticated-direct', directAuthId: 'lost-response-direct' }
      })
    )
    // The coordinator deliberately ignores the acknowledgement and recovers
    // only from the durable status after its control transport disappears.
    await new Promise((resolveWait) => setTimeout(resolveWait, 25))
    firstHost.socket.terminate()
    const rebound = await openHostControl({
      keyPair: firstHost.keyPair,
      controlResumeSecret: String(firstHost.ack.controlResumeSecret),
      previousGeneration: Number(firstHost.ack.generation)
    })
    const status = nextMessage(rebound.socket)
    rebound.socket.send(
      JSON.stringify({
        type: 'device-credential-install-status',
        v: 1,
        reqId: 'lost-response-install',
        relayDeviceId: 'lost-response-device'
      })
    )
    expect(await status).toMatchObject({
      type: 'device-credential-install-status-result',
      state: 'committed',
      result: { authorizationMode: 'authenticated-direct', currentVersion: 1 }
    })

    const invalidatedInvite = new WebSocket(
      `${relayUrl.replace('http:', 'ws:')}/v1/connect/${hostId}`,
      { headers: forwardedHeaders() }
    )
    await new Promise<void>((resolveOpen, reject) => {
      invalidatedInvite.once('open', resolveOpen)
      invalidatedInvite.once('error', reject)
    })
    const rejectedInvite = nextMessage(invalidatedInvite)
    invalidatedInvite.send(
      JSON.stringify({ type: 'relay-auth', v: 1, mode: 'connect', credential: invite.inviteToken })
    )
    expect(await rejectedInvite).toEqual({ type: 'relay-hello', ok: false, code: 4401 })

    const unauthorized = nextMessage(rebound.socket)
    rebound.socket.send(
      JSON.stringify({
        type: 'device-credential-install',
        v: 1,
        reqId: 'unauthorized-install',
        relayDeviceId: 'unauthorized-device',
        newResumeTokenHash: createHash('sha256').update('unauthorized').digest('base64url'),
        authorization: { mode: 'relay-basis', basisConnId: 'unknown-basis' }
      })
    )
    expect(await unauthorized).toMatchObject({
      type: 'control-error',
      reqId: 'unauthorized-install',
      code: 'invalid_relay_basis'
    })
    const missing = nextMessage(rebound.socket)
    rebound.socket.send(
      JSON.stringify({
        type: 'device-credential-install-status',
        v: 1,
        reqId: 'unauthorized-install',
        relayDeviceId: 'unauthorized-device'
      })
    )
    expect(await missing).toMatchObject({
      type: 'device-credential-install-status-result',
      state: 'not-found'
    })
    rebound.socket.close()
  })

  it('serializes confirmation against direct rotation, relay rotation, and revoke', async () => {
    const host = await openHostControl()
    const hostId = createHash('sha256')
      .update(host.keyPair.publicKey)
      .digest('base64url')
      .slice(0, 16)
    const firstToken = Buffer.alloc(32, 21).toString('base64url')
    await installDirectCredential({
      host: host.socket,
      relayDeviceId: 'confirm-race-device',
      reqId: 'confirm-race-initial',
      resumeToken: firstToken
    })

    const firstResume = await attachPhone({
      host: host.socket,
      hostAck: host.ack,
      hostId,
      credential: firstToken
    })
    const secondToken = Buffer.alloc(32, 22).toString('base64url')
    const directResponses = collectMessages(host.socket, 2)
    host.socket.send(
      JSON.stringify({
        type: 'device-resume-confirm',
        v: 1,
        reqId: 'confirm-before-direct',
        basisConnId: firstResume.connId
      })
    )
    host.socket.send(
      JSON.stringify({
        type: 'device-credential-install',
        v: 1,
        reqId: 'direct-after-confirm',
        relayDeviceId: 'confirm-race-device',
        newResumeTokenHash: createHash('sha256').update(secondToken).digest('base64url'),
        expectedCurrentHash: createHash('sha256').update(firstToken).digest('base64url'),
        authorization: { mode: 'authenticated-direct', directAuthId: 'direct-after-confirm' }
      })
    )
    const directResults = await directResponses
    expect(directResults.find((result) => result.type === 'device-resume-confirmed')).toMatchObject({
      reqId: 'confirm-before-direct',
      currentVersion: 1,
      renewed: true
    })
    expect(directResults.find((result) => result.type === 'device-credential-installed')).toMatchObject({
      reqId: 'direct-after-confirm',
      currentVersion: 2
    })
    const replayPromise = nextMessage(host.socket)
    host.socket.send(
      JSON.stringify({
        type: 'device-resume-confirm',
        v: 1,
        reqId: 'confirm-before-direct',
        basisConnId: firstResume.connId
      })
    )
    expect(await replayPromise).toEqual(
      directResults.find((result) => result.type === 'device-resume-confirmed')
    )

    const secondResume = await attachPhone({
      host: host.socket,
      hostAck: host.ack,
      hostId,
      credential: secondToken
    })
    const inviteResponse = nextMessage(host.socket)
    host.socket.send(
      JSON.stringify({
        type: 'invite-create',
        reqId: 'relay-rotation-invite',
        relayDeviceId: 'confirm-race-device'
      })
    )
    const invite = await inviteResponse
    const inviteSplice = await attachPhone({
      host: host.socket,
      hostAck: host.ack,
      hostId,
      credential: String(invite.inviteToken)
    })
    const thirdToken = Buffer.alloc(32, 23).toString('base64url')
    const relayResponses = collectMessages(host.socket, 2)
    host.socket.send(
      JSON.stringify({
        type: 'device-credential-install',
        v: 1,
        reqId: 'relay-before-confirm',
        relayDeviceId: 'confirm-race-device',
        newResumeTokenHash: createHash('sha256').update(thirdToken).digest('base64url'),
        expectedCurrentHash: createHash('sha256').update(secondToken).digest('base64url'),
        authorization: { mode: 'relay-basis', basisConnId: inviteSplice.connId }
      })
    )
    host.socket.send(
      JSON.stringify({
        type: 'device-resume-confirm',
        v: 1,
        reqId: 'confirm-after-relay',
        basisConnId: secondResume.connId
      })
    )
    const relayResults = await relayResponses
    expect(relayResults.find((result) => result.type === 'device-credential-installed')).toMatchObject({
      reqId: 'relay-before-confirm',
      currentVersion: 3
    })
    expect(relayResults.find((result) => result.type === 'device-resume-confirmed')).toMatchObject({
      reqId: 'confirm-after-relay',
      currentVersion: 3,
      renewed: false
    })

    const retiredResume = await attachPhone({
      host: host.socket,
      hostAck: host.ack,
      hostId,
      credential: secondToken
    })
    const fourthToken = Buffer.alloc(32, 24).toString('base64url')
    expect(
      await installDirectCredential({
        host: host.socket,
        relayDeviceId: 'confirm-race-device',
        reqId: 'retire-before-confirm',
        resumeToken: fourthToken
      })
    ).toMatchObject({ type: 'device-credential-installed', currentVersion: 4 })
    const retiredResult = nextMessage(host.socket)
    host.socket.send(
      JSON.stringify({
        type: 'device-resume-confirm',
        v: 1,
        reqId: 'confirm-retired',
        basisConnId: retiredResume.connId
      })
    )
    expect(await retiredResult).toMatchObject({
      type: 'control-error',
      reqId: 'confirm-retired',
      code: 'reject-retired'
    })

    const currentResume = await attachPhone({
      host: host.socket,
      hostAck: host.ack,
      hostId,
      credential: fourthToken
    })
    const revokeResponses = collectMessages(host.socket, 2)
    host.socket.send(
      JSON.stringify({
        type: 'device-revoke',
        reqId: 'revoke-before-confirm',
        relayDeviceId: 'confirm-race-device'
      })
    )
    host.socket.send(
      JSON.stringify({
        type: 'device-resume-confirm',
        v: 1,
        reqId: 'confirm-after-revoke',
        basisConnId: currentResume.connId
      })
    )
    const revokeResults = await revokeResponses
    expect(revokeResults.find((result) => result.type === 'device-revoked')).toMatchObject({
      reqId: 'revoke-before-confirm'
    })
    expect(revokeResults.find((result) => result.type === 'control-error')).toMatchObject({
      reqId: 'confirm-after-revoke',
      code: 'reject-revoked'
    })

    for (const splice of [firstResume, secondResume, inviteSplice, retiredResume, currentResume]) {
      splice.phone.close()
      splice.data.close()
    }
    host.socket.close()
  })

  it('enforces the eight-splice host limit with typed 4429 recovery', async () => {
    const host = await openHostControl()
    const hostId = createHash('sha256')
      .update(host.keyPair.publicKey)
      .digest('base64url')
      .slice(0, 16)
    const resumeToken = Buffer.alloc(32, 13).toString('base64url')
    await installDirectCredential({
      host: host.socket,
      relayDeviceId: 'limit-device',
      reqId: 'limit-install',
      resumeToken
    })
    const splices = []
    for (let index = 0; index < 8; index++) {
      splices.push(
        await attachPhone({ host: host.socket, hostAck: host.ack, hostId, credential: resumeToken })
      )
    }
    const ninth = new WebSocket(`${relayUrl.replace('http:', 'ws:')}/v1/connect/${hostId}`, {
      headers: forwardedHeaders()
    })
    await new Promise<void>((resolveOpen) => ninth.once('open', resolveOpen))
    const rejected = nextMessage(ninth)
    ninth.send(
      JSON.stringify({ type: 'relay-auth', v: 1, mode: 'connect', credential: resumeToken })
    )
    expect(await rejected).toEqual({ type: 'relay-hello', ok: false, code: 4429 })
    for (const splice of splices) {
      splice.phone.close()
      splice.data.close()
    }
    host.socket.close()
  })

  it('rolls an aborted invite reservation into bounded cooldown before retry', async () => {
    const host = await openHostControl()
    const hostId = createHash('sha256')
      .update(host.keyPair.publicKey)
      .digest('base64url')
      .slice(0, 16)
    const inviteResponse = nextMessage(host.socket)
    host.socket.send(
      JSON.stringify({ type: 'invite-create', reqId: 'cooldown-invite', relayDeviceId: 'cooldown-device' })
    )
    const invite = await inviteResponse
    const first = new WebSocket(`${relayUrl.replace('http:', 'ws:')}/v1/connect/${hostId}`, {
      headers: forwardedHeaders()
    })
    await new Promise<void>((resolveOpen) => first.once('open', resolveOpen))
    const firstOpen = nextMessage(host.socket)
    first.send(
      JSON.stringify({ type: 'relay-auth', v: 1, mode: 'connect', credential: invite.inviteToken })
    )
    await firstOpen
    first.close()
    await new Promise((resolveWait) => setTimeout(resolveWait, 50))

    const cooldown = new WebSocket(`${relayUrl.replace('http:', 'ws:')}/v1/connect/${hostId}`, {
      headers: forwardedHeaders()
    })
    await new Promise<void>((resolveOpen) => cooldown.once('open', resolveOpen))
    const cooldownHello = nextMessage(cooldown)
    cooldown.send(
      JSON.stringify({ type: 'relay-auth', v: 1, mode: 'connect', credential: invite.inviteToken })
    )
    expect(await cooldownHello).toEqual({ type: 'relay-hello', ok: false, code: 4401 })

    await new Promise((resolveWait) => setTimeout(resolveWait, 2_050))
    const retry = new WebSocket(`${relayUrl.replace('http:', 'ws:')}/v1/connect/${hostId}`, {
      headers: forwardedHeaders()
    })
    await new Promise<void>((resolveOpen) => retry.once('open', resolveOpen))
    const retriedOpen = nextMessage(host.socket)
    retry.send(
      JSON.stringify({ type: 'relay-auth', v: 1, mode: 'connect', credential: invite.inviteToken })
    )
    expect(await retriedOpen).toMatchObject({ type: 'conn-open', kind: 'invite' })
    retry.close()
    host.socket.close()
  })

  it('keeps install status and every effect not-found after injected SQL failure', async () => {
    const originalUrl = relayUrl
    const faultPort = await unusedPort()
    const faultUrl = `http://127.0.0.1:${faultPort}`
    const faultData = mkdtempSync(resolve(tmpdir(), 'orca-relay-fault-'))
    const faultProcess = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/fault-injection-test-entry.ts'],
      {
        cwd: appDirectory,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          PORT: String(faultPort),
          ORCA_RELAY_PUBLIC_URL: faultUrl,
          ORCA_RELAY_CELL_URL: faultUrl,
          ORCA_RELAY_AUTH_ISSUER: issuer,
          ORCA_RELAY_JWKS_URL: `${issuer}/jwks`,
          ORCA_RELAY_ASSIGNMENT_SIGNING_KEY: assignmentKey,
          ORCA_RELAY_DATA_DIR: faultData,
          ORCA_RELAY_ADMIN_AUDIENCE: adminAudience,
          ORCA_RELAY_DEPLOY_SERVICE_ACCOUNT: 'deploy@example.com',
          ORCA_RELAY_ADMIN_JWKS_URL: `${issuer}/jwks`,
          ORCA_RELAY_TEST_FAULT_SQL: 'INSERT INTO relay_install_results'
        },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    relayUrl = faultUrl
    try {
      await waitForRelay(faultProcess)
      const host = await openHostControl()
      const hostId = createHash('sha256')
        .update(host.keyPair.publicKey)
        .digest('base64url')
        .slice(0, 16)
      const inviteResponse = nextMessage(host.socket)
      host.socket.send(
        JSON.stringify({ type: 'invite-create', reqId: 'fault-invite', relayDeviceId: 'fault-device' })
      )
      const invite = await inviteResponse
      const splice = await attachPhone({
        host: host.socket,
        hostAck: host.ack,
        hostId,
        credential: String(invite.inviteToken)
      })
      const install = {
        type: 'device-credential-install',
        v: 1,
        reqId: 'fault-install',
        relayDeviceId: 'fault-device',
        newResumeTokenHash: createHash('sha256').update('fault-resume').digest('base64url'),
        authorization: { mode: 'relay-basis', basisConnId: splice.connId }
      }
      const failed = nextMessage(host.socket)
      host.socket.send(JSON.stringify(install))
      expect(await failed).toMatchObject({
        type: 'control-error',
        reqId: 'fault-install',
        code: 'injected SQL failure'
      })
      const status = nextMessage(host.socket)
      host.socket.send(
        JSON.stringify({
          type: 'device-credential-install-status',
          v: 1,
          reqId: 'fault-install',
          relayDeviceId: 'fault-device'
        })
      )
      expect(await status).toMatchObject({
        type: 'device-credential-install-status-result',
        state: 'not-found'
      })
      const retried = nextMessage(host.socket)
      host.socket.send(JSON.stringify(install))
      expect(await retried).toMatchObject({
        type: 'device-credential-installed',
        currentVersion: 1
      })
      splice.phone.close()
      splice.data.close()
      host.socket.close()
    } finally {
      faultProcess.kill('SIGKILL')
      await new Promise<void>((resolveExit) => faultProcess.once('exit', () => resolveExit()))
      relayUrl = originalUrl
      rmSync(faultData, { recursive: true, force: true })
    }
  })

  it('falls back to an invite only after a failed direct attempt is authoritatively not-found', async () => {
    const originalUrl = relayUrl
    const faultPort = await unusedPort()
    const faultUrl = `http://127.0.0.1:${faultPort}`
    const faultData = mkdtempSync(resolve(tmpdir(), 'orca-relay-direct-fault-'))
    const faultProcess = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/fault-injection-test-entry.ts'],
      {
        cwd: appDirectory,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          PORT: String(faultPort),
          ORCA_RELAY_PUBLIC_URL: faultUrl,
          ORCA_RELAY_CELL_URL: faultUrl,
          ORCA_RELAY_AUTH_ISSUER: issuer,
          ORCA_RELAY_JWKS_URL: `${issuer}/jwks`,
          ORCA_RELAY_ASSIGNMENT_SIGNING_KEY: assignmentKey,
          ORCA_RELAY_DATA_DIR: faultData,
          ORCA_RELAY_ADMIN_AUDIENCE: adminAudience,
          ORCA_RELAY_DEPLOY_SERVICE_ACCOUNT: 'deploy@example.com',
          ORCA_RELAY_ADMIN_JWKS_URL: `${issuer}/jwks`,
          ORCA_RELAY_TEST_FAULT_SQL: 'INSERT INTO relay_direct_authorizations'
        },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    relayUrl = faultUrl
    try {
      await waitForRelay(faultProcess)
      const host = await openHostControl()
      const hostId = createHash('sha256')
        .update(host.keyPair.publicKey)
        .digest('base64url')
        .slice(0, 16)
      const inviteResponse = nextMessage(host.socket)
      host.socket.send(
        JSON.stringify({
          type: 'invite-create',
          reqId: 'fallback-invite',
          relayDeviceId: 'fallback-device'
        })
      )
      const invite = await inviteResponse
      const splice = await attachPhone({
        host: host.socket,
        hostAck: host.ack,
        hostId,
        credential: String(invite.inviteToken)
      })
      const installBase = {
        type: 'device-credential-install',
        v: 1,
        reqId: 'fallback-install',
        relayDeviceId: 'fallback-device',
        newResumeTokenHash: createHash('sha256').update('fallback-resume').digest('base64url')
      }
      const directFailure = nextMessage(host.socket)
      host.socket.send(
        JSON.stringify({
          ...installBase,
          authorization: { mode: 'authenticated-direct', directAuthId: 'failed-direct' }
        })
      )
      expect(await directFailure).toMatchObject({
        type: 'control-error',
        reqId: 'fallback-install',
        code: 'injected SQL failure'
      })
      const status = nextMessage(host.socket)
      host.socket.send(
        JSON.stringify({
          type: 'device-credential-install-status',
          v: 1,
          reqId: 'fallback-install',
          relayDeviceId: 'fallback-device'
        })
      )
      expect(await status).toMatchObject({
        type: 'device-credential-install-status-result',
        state: 'not-found'
      })
      const fallback = nextMessage(host.socket)
      host.socket.send(
        JSON.stringify({
          ...installBase,
          authorization: { mode: 'relay-basis', basisConnId: splice.connId }
        })
      )
      expect(await fallback).toMatchObject({
        type: 'device-credential-installed',
        authorizationMode: 'relay-basis',
        currentVersion: 1
      })
      splice.phone.close()
      splice.data.close()
      host.socket.close()
    } finally {
      faultProcess.kill('SIGKILL')
      await new Promise<void>((resolveExit) => faultProcess.once('exit', () => resolveExit()))
      relayUrl = originalUrl
      rmSync(faultData, { recursive: true, force: true })
    }
  })

  it('keeps director HTTP routes off cells and enforces the durable cell epoch', async () => {
    const originalUrl = relayUrl
    const cellPort = await unusedPort()
    const cellUrl = `http://127.0.0.1:${cellPort}`
    const cellData = mkdtempSync(resolve(tmpdir(), 'orca-relay-cell-'))
    const keyPair = nacl.box.keyPair()
    const hostId = createHash('sha256')
      .update(keyPair.publicKey)
      .digest('base64url')
      .slice(0, 16)
    const database = await openRelayDatabase({ dataDir: cellData })
    const assignments = new RelayAssignmentStore(database, () => 100)
    await assignments.reconcileCells([{ id: 'cell-a', url: cellUrl, capacityRequests: 10 }])
    await assignments.assign({ userId: 'user-1', relayHostId: hostId })
    await database.close()
    const cellProcess = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: appDirectory,
      env: {
        ...process.env,
        PORT: String(cellPort),
        ORCA_RELAY_PUBLIC_URL: cellUrl,
        ORCA_RELAY_CELL_URL: cellUrl,
        ORCA_RELAY_CELL_ID: 'cell-a',
        ORCA_RELAY_CELL_CAPACITY: '10',
        ORCA_RELAY_ROLE: 'cell',
        ORCA_RELAY_AUTH_ISSUER: issuer,
        ORCA_RELAY_JWKS_URL: `${issuer}/jwks`,
        ORCA_RELAY_ASSIGNMENT_SIGNING_KEY: assignmentKey,
        ORCA_RELAY_DATA_DIR: cellData,
        ORCA_RELAY_ADMIN_AUDIENCE: adminAudience,
        ORCA_RELAY_DEPLOY_SERVICE_ACCOUNT: 'deploy@example.com',
        ORCA_RELAY_ADMIN_JWKS_URL: `${issuer}/jwks`
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    relayUrl = cellUrl
    try {
      await waitForRelay(cellProcess)
      const token = await relayToken('orca-relay', hostId)
      const assignmentResponse = await fetch(`${cellUrl}/v1/assign`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ v: 1, relayHostId: hostId })
      })
      expect(assignmentResponse.status).toBe(404)
      const cellStatusResponse = await fetch(`${cellUrl}/v1/admin/cell-status`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ v: 1, cellId: 'cell-a' })
      })
      expect(cellStatusResponse.status).toBe(404)

      const stale = new WebSocket(`${cellUrl.replace('http:', 'ws:')}/v1/host/control`, {
        headers: { authorization: `Bearer ${token}` }
      })
      await new Promise<void>((resolveOpen) => stale.once('open', resolveOpen))
      const staleClosed = new Promise<number>((resolveClose) =>
        stale.once('close', (code) => resolveClose(code))
      )
      stale.send(
        JSON.stringify({
          type: 'host-hello',
          v: 1,
          relayHostId: hostId,
          assignmentEpoch: 2,
          hostPublicKeyB64: Buffer.from(keyPair.publicKey).toString('base64'),
          appVersion: 'test'
        })
      )
      expect(await staleClosed).toBe(4409)

      const assigned = await openHostControl({ keyPair })
      expect(assigned.ack).toMatchObject({ type: 'host-hello-ack', generation: 1 })
      const invitePromise = nextMessage(assigned.socket)
      assigned.socket.send(
        JSON.stringify({ type: 'invite-create', reqId: 'cell-invite', relayDeviceId: 'cell-device' })
      )
      const invite = await invitePromise
      const splice = await attachPhone({
        host: assigned.socket,
        hostAck: assigned.ack,
        hostId,
        credential: String(invite.inviteToken)
      })
      const observedDatabase = await openRelayDatabase({ dataDir: cellData })
      const activities = await observedDatabase.query(
        `SELECT activity_kind, request_units FROM relay_assignment_activity_leases
         ORDER BY activity_kind, activity_id`
      )
      await observedDatabase.close()
      expect(activities).toEqual([
        { activity_kind: 'control', request_units: 1 },
        { activity_kind: 'invite', request_units: 1 },
        { activity_kind: 'invite', request_units: 1 },
        { activity_kind: 'splice', request_units: 2 }
      ])
      splice.phone.close()
      splice.data.close()
      assigned.socket.close()
    } finally {
      cellProcess.kill('SIGTERM')
      await new Promise<void>((resolveExit) => cellProcess.once('exit', () => resolveExit()))
      relayUrl = originalUrl
      rmSync(cellData, { recursive: true, force: true })
    }
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
    const hostId = createHash('sha256')
      .update(keyPair.publicKey)
      .digest('base64url')
      .slice(0, 16)
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
            generationIdentity:
              'https://compute.example/instanceTemplates/orca-relay-c1-abc',
            fenceCommit: 'a'.repeat(40),
            planSha256: 'b'.repeat(64),
            planObjectName:
              'terraform/state/relay-fence-plans/production/44444444-4444-4444-8444-444444444444.tfplan',
            varFileSha256: 'c'.repeat(64),
            terraformStateLineage: 'c739dab4-e6e1-e627-02a9-504b3dda1a2c',
            terraformStateSerial: 7,
            terraformStateObjectGeneration: '987654321',
            terraformStateObjectSha256: 'd'.repeat(64),
            requestReason:
              'orca-relay-fence/44444444-4444-4444-8444-444444444444'
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
            generationIdentity:
              'https://compute.example/instanceTemplates/orca-relay-c1-abc',
            fenceCommit: 'a'.repeat(40),
            planSha256: 'b'.repeat(64),
            planObjectName:
              'terraform/state/relay-fence-plans/production/44444444-4444-4444-8444-444444444444.tfplan',
            varFileSha256: 'c'.repeat(64),
            terraformStateLineage: 'c739dab4-e6e1-e627-02a9-504b3dda1a2c',
            terraformStateSerial: 7,
            terraformStateObjectGeneration: '987654321',
            terraformStateObjectSha256: 'd'.repeat(64),
            requestReason:
              'orca-relay-fence/44444444-4444-4444-8444-444444444444'
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
      // Completion must prove the source has stopped admitting new work, even in
      // the served admin workflow that performs its own topology preflight.
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
      const selectorResponse = await fetch(
        `${directorUrl}/v1/admin/admission-selector/apply`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify(selectorInput)
        }
      )
      expect(selectorResponse.status).toBe(200)
      expect(await selectorResponse.json()).toMatchObject({
        v: 1,
        changed: true,
        selector: { generation: 1, membership: selectorInput.membership }
      })
      const selectorStatus = await fetch(
        `${directorUrl}/v1/admin/admission-selector/status`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({ v: 1, attemptId: selectorInput.attemptId })
        }
      )
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
        if (child && child.exitCode === null) child.kill('SIGKILL')
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

    relayProcess.kill('SIGKILL')
    await new Promise<void>((resolveExit) => relayProcess.once('exit', () => resolveExit()))
    const directorPort = await unusedPort()
    relayUrl = `http://127.0.0.1:${directorPort}`
    relayProcess = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
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

    relayProcess.kill('SIGTERM')
    await new Promise<void>((resolveExit) => relayProcess.once('exit', () => resolveExit()))
    relayUrl = combinedUrl
    relayProcess = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
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
    const signalProcess = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
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
      if (signalProcess.exitCode === null) signalProcess.kill('SIGKILL')
      relayUrl = originalUrl
      rmSync(signalData, { recursive: true, force: true })
    }
  })

  it('authenticates admin drain with exact Google audience and deploy identity', async () => {
    const host = await openHostControl()
    const drainMessage = nextMessage(host.socket)
    const closed = new Promise<number>((resolveClose) =>
      host.socket.once('close', (code) => resolveClose(code))
    )
    const token = await new SignJWT({ email: 'deploy@example.com', email_verified: true })
      .setProtectedHeader({ alg: 'RS256', kid: 'admin-key' })
      .setIssuer('https://accounts.google.com')
      .setAudience(adminAudience)
      .setSubject('deploy-subject')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(adminPrivateKey)
    const response = await fetch(`${relayUrl}/v1/admin/drain`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ v: 1, graceMs: 0 })
    })
    expect(response.status).toBe(200)
    expect(await drainMessage).toEqual({
      type: 'drain',
      graceMs: 0,
      recovery: 'resolve-director'
    })
    expect(await closed).toBe(4503)
  })

  it('keeps dedicated capacity, monitor, and fence identities on exact routes', async () => {
    const capacity = await googleServiceToken(adminAudience, 'capacity@example.com')
    const monitor = await googleServiceToken(adminAudience, 'monitor@example.com')
    const fence = await googleServiceToken(adminAudience, 'fence@example.com')
    const broker = await googleServiceToken(adminAudience, 'broker@example.com')
    const post = async (path: string, token: string, body: unknown): Promise<Response> =>
      await fetch(`${relayUrl}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify(body)
      })

    expect((await post('/v1/admin/runtime-status', capacity, { v: 1 })).status).toBe(200)
    expect(
      (await post('/v1/admin/evacuation-status', capacity, {
        v: 1,
        sourceCellId: 'source',
        targetCellId: 'target',
        completeReady: false
      })).status
    ).toBe(401)
    expect(
      (await post('/v1/admin/cell-fence-attempt-status', capacity, {
        v: 1,
        cellId: 'production-gce-c1'
      })).status
    ).toBe(401)

    expect((await post('/v1/admin/runtime-status', monitor, { v: 1 })).status).toBe(200)
    expect((await post('/v1/admin/drain', monitor, { v: 1, graceMs: 0 })).status).toBe(401)
    expect(
      (await post('/v1/admin/cell-fence-attempt-status', monitor, {
        v: 1,
        cellId: 'production-gce-c1'
      })).status
    ).toBe(401)

    expect((await post('/v1/admin/runtime-status', fence, { v: 1 })).status).toBe(200)
    expect((await post('/v1/admin/drain', fence, { v: 1, graceMs: 0 })).status).toBe(401)
    expect(
      (await post('/v1/admin/cell-fence-attempt-status', fence, {
        v: 1,
        cellId: 'production-gce-c1'
      })).status
    ).toBe(404)
    expect(
      (await post('/v1/admin/cell-fence-attest', fence, {
        v: 1
      })).status
    ).toBe(401)

    const directorPort = await unusedPort()
    const directorUrl = `http://127.0.0.1:${directorPort}`
    const directorData = mkdtempSync(resolve(tmpdir(), 'orca-relay-monitor-auth-'))
    const director = spawnTopologyRelay({
      url: directorUrl,
      dataDirectory: directorData,
      role: 'director',
      cellId: 'director',
      cells: [{ id: 'cell-a', url: 'https://cell-a.example.com', capacityRequests: 10 }]
    })
    try {
      await waitForRelay(director)
      const adoption = {
        v: 1,
        cellId: 'cell-a',
        cellIncarnation: '11111111-1111-4111-8111-111111111111',
        confirmation: 'ADOPT_LEGACY_TERRAFORM_CELL_FENCE'
      }
      const postDirector = async (token: string): Promise<Response> =>
        await fetch(`${directorUrl}/v1/admin/cell-fence-adopt-legacy`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify(adoption)
        })
      expect(
        (await postDirector(fence)).status
      ).toBe(401)
      expect(
        (await postDirector(broker)).status
      ).toBe(409)
      const commitAdoption = {
        v: 1,
        cellId: 'cell-a',
        cellIncarnation: '11111111-1111-4111-8111-111111111111',
        confirmation: 'COMMIT_LEGACY_TERRAFORM_CELL_FENCE_ADOPTION'
      }
      const postCommit = async (token: string): Promise<Response> =>
        await fetch(`${directorUrl}/v1/admin/cell-fence-commit-legacy-adoption`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify(commitAdoption)
        })
      expect((await postCommit(fence)).status).toBe(401)
      expect((await postCommit(broker)).status).toBe(409)
      const response = await fetch(`${directorUrl}/v1/admin/evacuation-status`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${monitor}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          v: 1,
          sourceCellId: 'cell-a',
          targetCellId: 'cell-b',
          completeReady: true
        })
      })
      expect(response.status).toBe(403)
      const fenceResponse = await fetch(`${directorUrl}/v1/admin/evacuation-status`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${fence}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          v: 1,
          sourceCellId: 'cell-a',
          targetCellId: 'cell-b',
          completeReady: true
        })
      })
      expect(fenceResponse.status).toBe(403)
    } finally {
      if (director.exitCode === null) director.kill('SIGKILL')
      rmSync(directorData, { recursive: true, force: true })
    }
  })

  it('reports only authenticated aggregate runtime identity and the served digest', async () => {
    const token = await adminToken()
    expect(
      await fetch(`${relayUrl}/v1/admin/runtime-status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ v: 1 })
      })
    ).toMatchObject({ status: 401 })
    expect(
      await fetch(`${relayUrl}/v1/admin/runtime-status`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ v: 1, hostId: 'must-not-be-accepted' })
      })
    ).toMatchObject({ status: 400 })
    const response = await fetch(`${relayUrl}/v1/admin/runtime-status`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1 })
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      v: 1,
      role: 'combined',
      cellId: 'combined',
      cellUrl: relayUrl,
      region: 'us-central1',
      imageDigest: `sha256:${'a'.repeat(64)}`,
      draining: true,
      regionalRehomeProtocol: 0,
      connectionCapacity: null,
      runtime: {
        totalConnections: 0,
        preAuthConnections: 0,
        controls: 0,
        splices: 0,
        pendingSplices: 0,
        queuedBytes: 0
      }
    })
  })
})
