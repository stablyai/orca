import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import nacl from 'tweetnacl'
import { isRemoteRuntimeConnectTimeout } from '../../../shared/remote-runtime-connect-bound'
import { RelayControlClient } from './relay-control-client'

const servers = new Set<Server>()
const sockets = new Set<Socket>()

afterEach(async () => {
  for (const socket of sockets) {
    socket.destroy()
  }
  sockets.clear()
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        })
    )
  )
  servers.clear()
})

/**
 * Accepts TCP and never answers the HTTP upgrade, so the socket never opens.
 * The incumbent relay test stalls the *proving* phase instead, which the
 * transport bound cannot see — only this shape distinguishes the two bounds.
 */
async function listenSilentUpgradeServer(): Promise<string> {
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  servers.add(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('expected a TCP address')
  }
  return `http://127.0.0.1:${address.port}`
}

function buildClient(cellUrl: string, overrides: { handshakeTimeoutMs?: number }) {
  const keypair = nacl.box.keyPair()
  return new RelayControlClient({
    cellUrl,
    relayJwt: 'scoped-token',
    relayHostId: createHash('sha256').update(keypair.publicKey).digest('base64url').slice(0, 16),
    assignmentEpoch: 1,
    identity: { userId: 'user-1', profileId: 'profile-1', organizationId: 'org-1' },
    keypair: { ...keypair, publicKeyB64: Buffer.from(keypair.publicKey).toString('base64') },
    appVersion: '1.2.3',
    onConnectionOpen: vi.fn(),
    onDrain: vi.fn(),
    onClose: vi.fn(),
    // Why: 50x the transport bound, so whichever error arrives names the bound
    // that produced it rather than the one that merely exists.
    connectDeadlineMs: 5_000,
    ...overrides
  })
}

describe('relay control connect transport bound', () => {
  it('bounds a connect that never opens, and names the transport bound', async () => {
    const cellUrl = await listenSilentUpgradeServer()
    const client = buildClient(cellUrl, { handshakeTimeoutMs: 100 })

    const error = await client.connect().then(
      () => null,
      (reason: unknown) => reason as Error
    )

    expect(error).toBeInstanceOf(Error)
    // The transport bound fired, not the class deadline that also covers this.
    expect(isRemoteRuntimeConnectTimeout(error)).toBe(true)
    expect(error?.message).not.toContain('relay_control_connect_timeout')
  })

  // Why: defence in depth only works if both bounds survive. Either one removed
  // as "redundant" leaves a phase uncovered.
  it('keeps both bounds, since each covers a phase the other cannot', () => {
    const client = readFileSync(join(__dirname, 'relay-control-client.ts'), 'utf8')
    const factory = readFileSync(join(__dirname, 'relay-control-socket-factory.ts'), 'utf8')
    expect(factory).toContain('remoteRuntimeConnectOptions(')
    expect(client).toContain('this.connectTimer = setTimeout(')
    expect(client).toContain("new Error('relay_control_connect_timeout')")
  })
})
