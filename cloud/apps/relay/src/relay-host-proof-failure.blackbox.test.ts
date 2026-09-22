import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { RELAY_CLOSE_CODE } from '@orca-cloud/relay-contract'
import nacl from 'tweetnacl'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import type { RelayConfig } from './config.js'
import type { RelayDatabase } from './database.js'
import { createRelayServer } from './relay-server.js'

async function unusedPort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing test port')
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}

describe('relay host proof failures', () => {
  const cleanup: Array<() => Promise<void> | void> = []

  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close()
    vi.restoreAllMocks()
  })

  // The production crash signature: a pg-pool connect timeout rejecting out of
  // verifyCellAssignment inside beginProof killed whole cells as an unhandled
  // rejection. The guard must contain it to this one handshake.
  it('contains a database timeout during host hello to one socket', async () => {
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
    const poolTimeout = new Error('Connection terminated due to connection timeout')
    const database: RelayDatabase = {
      query: vi.fn(async () => {
        throw poolTimeout
      }),
      queryLocked: vi.fn(async () => {
        throw poolTimeout
      }),
      transaction: vi.fn(async (operation) => await operation(database)),
      close: vi.fn(async () => undefined)
    }
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
      cells: [{ id: 'production-gce-c3', url: relayUrl, capacityRequests: 4_000 }],
      adminAudience: `${relayUrl}/admin`,
      deployServiceAccount: 'deploy@example.com',
      runtimeServiceAccount: 'runtime@example.com',
      connectionHardCap: 600,
      connectionUnobservedBound: 60,
      adminJwksUrl: `${issuer}/admin-jwks`,
      databasePoolMax: 10,
      publicAssignmentsEnabled: true,
      publicAssignmentConcurrency: 2,
      publicAssignmentQueueMax: 128,
      publicAssignmentWaitMs: 4_000,
      publicResolveConcurrency: 1,
      publicResolveWaitMs: 5_000,
      publicAssignmentRetryAfterSeconds: 5,
      dataDir: './test-data'
    } satisfies RelayConfig
    const relay = createRelayServer(config, database)
    relay.server.listen(port, '127.0.0.1')
    await new Promise<void>((resolve) => relay.server.once('listening', resolve))
    cleanup.push(() => new Promise<void>((resolve) => relay.server.close(() => resolve())))
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    cleanup.push(() => {
      process.off('unhandledRejection', onUnhandled)
    })

    const keyPair = nacl.box.keyPair()
    const hostId = createHash('sha256')
      .update(keyPair.publicKey)
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
    const socket = new WebSocket(`${relayUrl.replace('http:', 'ws:')}/v1/host/control`, {
      headers: { authorization: `Bearer ${token}` },
      perMessageDeflate: false
    })
    cleanup.push(() => socket.terminate())
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    const closed = new Promise<number>((resolve) =>
      socket.once('close', (code) => resolve(code))
    )
    socket.send(
      JSON.stringify({
        type: 'host-hello',
        v: 1,
        relayHostId: hostId,
        assignmentEpoch: 1,
        hostPublicKeyB64: Buffer.from(keyPair.publicKey).toString('base64'),
        appVersion: 'test'
      })
    )

    expect(await closed).toBe(RELAY_CLOSE_CODE.LIMIT_EXCEEDED)
    expect(
      warn.mock.calls.map((call) => String(call[0]))
    ).toContain(
      '[orca-relay] host hello proof failed: Connection terminated due to connection timeout'
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(unhandled).toEqual([])
  })
})
