import { createHash, createHmac } from 'node:crypto'
import { generateKeyPair, exportJWK, SignJWT } from 'jose'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildHostProofMacInput,
  HOST_CHALLENGE_PLAINTEXT_DOMAIN
} from '@orca-cloud/relay-contract'
import nacl from 'tweetnacl'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import type { RawData } from 'ws'
import type { RelayConfig } from './config.js'
import { openRelayDatabase, type RelayDatabase } from './database.js'
import { createRelayServer } from './relay-server.js'

async function unusedPort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing test port')
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}

function openSocket(url: string, headers: Record<string, string> = {}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers })
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })
}

function rejectedUpgrade(
  url: string,
  headers: Record<string, string> = {}
): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers })
    socket.once('open', () => reject(new Error(`upgrade unexpectedly opened: ${url}`)))
    socket.once('unexpected-response', (_request, response) => {
      response.resume()
      resolve(response.statusCode)
    })
    socket.once('error', () => undefined)
  })
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

async function proveControl(
  socket: WebSocket,
  hostId: string,
  keyPair: nacl.BoxKeyPair,
  rebind?: { secret: string; generation: number }
): Promise<Record<string, unknown>> {
  socket.send(
    JSON.stringify({
      type: 'host-hello',
      v: 1,
      relayHostId: hostId,
      assignmentEpoch: 1,
      hostPublicKeyB64: Buffer.from(keyPair.publicKey).toString('base64'),
      appVersion: 'test',
      ...(rebind
        ? {
            controlResumeSecret: rebind.secret,
            previousGeneration: rebind.generation
          }
        : {})
    })
  )
  const challenge = await nextMessage(socket)
  const plaintext = nacl.box.open(
    Buffer.from(String(challenge.ciphertextB64), 'base64'),
    Buffer.from(String(challenge.nonceB64), 'base64'),
    Buffer.from(String(challenge.relayEphemeralPublicKeyB64), 'base64'),
    keyPair.secretKey
  )
  if (!plaintext) throw new Error('host challenge did not decrypt')
  const domainLength = new TextEncoder().encode(
    `${HOST_CHALLENGE_PLAINTEXT_DOMAIN}\0`
  ).length
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
  return await nextMessage(socket)
}

describe('relay connection hard cap', () => {
  const cleanup: Array<() => Promise<void> | void> = []

  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close()
  })

  it('preserves control headroom and never disturbs established sockets', async () => {
    const keys = await generateKeyPair('ES256')
    const publicJwk = await exportJWK(keys.publicKey)
    const adminKeys = await generateKeyPair('RS256')
    const adminPublicJwk = await exportJWK(adminKeys.publicKey)
    const jwks = createServer((_request, response) => {
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
    await new Promise<void>((resolve) => jwks.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>((resolve) => jwks.close(() => resolve())))
    const jwksAddress = jwks.address()
    if (!jwksAddress || typeof jwksAddress === 'string') throw new Error('missing JWKS address')
    const issuer = `http://127.0.0.1:${jwksAddress.port}`
    const port = await unusedPort()
    const relayUrl = `http://127.0.0.1:${port}`
    const dataDir = mkdtempSync(join(tmpdir(), 'orca-relay-hard-cap-'))
    cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }))
    const database: RelayDatabase = await openRelayDatabase({ dataDir })
    cleanup.push(() => database.close())
    const config = {
      port,
      publicUrl: relayUrl,
      cellUrl: relayUrl,
      authIssuer: issuer,
      authAudience: 'orca-relay',
      jwksUrl: `${issuer}/jwks`,
      assignmentSigningKey: new TextEncoder().encode('test-assignment-key-with-at-least-32-bytes'),
      role: 'combined',
      cellId: 'combined',
      cells: [
        {
          id: 'combined',
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
      adminJwksUrl: `${issuer}/jwks`,
      databasePoolMax: 10,
      publicAssignmentsEnabled: true,
      publicAssignmentConcurrency: 2,
      publicAssignmentQueueMax: 128,
      publicAssignmentWaitMs: 4_000,
      publicResolveConcurrency: 1,
      publicResolveWaitMs: 5_000,
      publicAssignmentRetryAfterSeconds: 5,
      dataDir
    } satisfies RelayConfig
    const relay = createRelayServer(config, database, {
      connectionLedgerLimits: { hardCap: 5, controlReserve: 1 }
    })
    relay.server.listen(port, '127.0.0.1')
    await new Promise<void>((resolve) => relay.server.once('listening', resolve))
    cleanup.push(() => new Promise<void>((resolve) => relay.server.close(() => resolve())))
    const wsUrl = relayUrl.replace('http:', 'ws:')
    const adminToken = await new SignJWT({
      email: 'deploy@example.com',
      email_verified: true
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'admin-key' })
      .setIssuer('https://accounts.google.com')
      .setAudience(`${relayUrl}/admin`)
      .setSubject('deploy-subject')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(adminKeys.privateKey)
    const statusResponse = await fetch(`${relayUrl}/v1/admin/runtime-status`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ v: 1 })
    })
    expect(statusResponse.status).toBe(200)
    expect(await statusResponse.json()).toMatchObject({
      connectionCapacity: {
        hardCap: 600,
        controlRebindReserve: 100,
        ordinaryConnectionLimit: 500,
        unobservedBound: 60,
        normalAdmissionPause: 440
      }
    })

    const unmatchedData = await Promise.all(
      ['unmatched-1', 'unmatched-2', 'unmatched-3'].map((connectionId) =>
        openSocket(`${wsUrl}/v1/host/data/${connectionId}`)
      )
    )
    cleanup.push(() => unmatchedData.forEach((socket) => socket.terminate()))
    expect(relay.runtimeCounts().enforcedConnectionUnits).toBe(3)
    expect(await rejectedUpgrade(`${wsUrl}/v1/connect/abcdefghijklmnop`)).toBe(503)
    expect(unmatchedData.every((socket) => socket.readyState === WebSocket.OPEN)).toBe(true)

    const hostKeyPair = nacl.box.keyPair()
    const hostId = createHash('sha256')
      .update(hostKeyPair.publicKey)
      .digest('base64url')
      .slice(0, 16)
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
    const controlHeaders = { authorization: `Bearer ${token}` }
    const control = await openSocket(`${wsUrl}/v1/host/control`, controlHeaders)
    cleanup.push(() => control.terminate())
    const controlAck = await proveControl(control, hostId, hostKeyPair)
    expect(controlAck).toMatchObject({ type: 'host-hello-ack', generation: 1 })
    expect(relay.runtimeCounts().enforcedConnectionUnits).toBe(4)
    expect(await rejectedUpgrade(`${wsUrl}/v1/host/data/another`)).toBe(503)
    const unrelatedToken = await new SignJWT({
      prof: 'profile-1',
      purpose: 'host-control',
      relayHostId: 'ponmlkjihgfedcba'
    })
      .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
      .setIssuer(issuer)
      .setAudience('orca-relay')
      .setSubject('user-2')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(keys.privateKey)
    expect(
      await rejectedUpgrade(`${wsUrl}/v1/host/control`, {
        authorization: `Bearer ${unrelatedToken}`
      })
    ).toBe(503)
    const failedBorrower = await openSocket(`${wsUrl}/v1/host/control`, controlHeaders)
    cleanup.push(() => failedBorrower.terminate())
    expect(relay.runtimeCounts().enforcedConnectionUnits).toBe(5)
    const failedBorrowerClosed = new Promise<number>((resolve) =>
      failedBorrower.once('close', (code) => resolve(code))
    )
    failedBorrower.send(JSON.stringify({ type: 'host-hello' }))
    expect(await failedBorrowerClosed).toBe(4401)
    await vi.waitFor(() => expect(relay.runtimeCounts().enforcedConnectionUnits).toBe(4))
    expect(control.readyState).toBe(WebSocket.OPEN)
    const replacementControl = await openSocket(`${wsUrl}/v1/host/control`, controlHeaders)
    cleanup.push(() => replacementControl.terminate())
    expect(relay.runtimeCounts().enforcedConnectionUnits).toBe(5)
    const controlClosed = new Promise<number>((resolve) =>
      control.once('close', (code) => resolve(code))
    )
    const replacementAck = await proveControl(replacementControl, hostId, hostKeyPair, {
      secret: String(controlAck.controlResumeSecret),
      generation: 1
    })
    expect(replacementAck).toMatchObject({ type: 'host-hello-ack', generation: 1 })
    expect(await controlClosed).toBe(4408)
    await vi.waitFor(() => expect(relay.runtimeCounts().enforcedConnectionUnits).toBe(4))
    expect(relay.runtimeCounts().enforcedConnectionUnits).toBe(4)
  })
})
