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

const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const assignmentKey = 'test-assignment-key-with-at-least-32-bytes'
let relayProcess: ChildProcess
let jwksServer: Server
let relayUrl: string
let issuer: string
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey']
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
