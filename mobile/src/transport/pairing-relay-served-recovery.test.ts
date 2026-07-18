import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket as NodeWebSocket, WebSocketServer } from 'ws'
import type { PairingRelay } from '../../../src/shared/mobile-relay-pairing-offer'
import {
  connectMobileRelayForPairing,
  type PairingCandidateClient
} from './mobile-relay-physical-client'
import type { MobileRelayPairingJournal } from './mobile-relay-pairing-journal'
import { createRecoveringPairingRelayCandidate } from './pairing-relay-candidate'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-crypto', () => ({
  getRandomBytes: (length: number) => new Uint8Array(length).fill(length)
}))

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  )
})

describe('served relay pairing recovery', () => {
  it('uses the configured director after an HTTP 502 WebSocket upgrade response', async () => {
    const cellUrl = await serveUpgradeFailure(502)
    const journal = createJournal(cellUrl)
    const resolvedRelay = {
      ...relayFromJournal(journal),
      cellUrl: 'https://c2.relay-staging.onorca.dev',
      assignmentEpoch: 8
    }
    const resolveDirector = vi.fn(async () => resolvedRelay)
    const persistMove = vi.fn(async () => {})
    const target = successfulClient()

    const candidate = createRecoveringPairingRelayCandidate({
      journal,
      connect: (relay) => (relay.assignmentEpoch === 7 ? servedPhysicalClient(relay) : target),
      resolveDirector,
      persistMove,
      now: () => 1,
      random: () => 0,
      sleep: async () => {}
    })

    await expect(candidate.sendRequest('status.get')).resolves.toMatchObject({ ok: true })
    expect(resolveDirector).toHaveBeenCalledOnce()
    expect(persistMove).toHaveBeenCalledWith(resolvedRelay)
  })

  it('keeps a served 4404 host-offline close scoped to the failed endpoint', async () => {
    const cellUrl = await serveCloseCode(4404)
    const journal = createJournal(cellUrl)
    const resolveDirector = vi.fn()
    const candidate = createRecoveringPairingRelayCandidate({
      journal,
      connect: servedPhysicalClient,
      resolveDirector,
      persistMove: vi.fn(async () => {}),
      now: () => 1
    })

    await expect(candidate.sendRequest('status.get')).rejects.toMatchObject({ code: 4404 })
    expect(resolveDirector).not.toHaveBeenCalled()
  })
})

function servedPhysicalClient(relay: PairingRelay): PairingCandidateClient {
  return connectMobileRelayForPairing({
    relay,
    deviceToken: 'device-token',
    desktopPublicKeyB64: Buffer.alloc(32, 7).toString('base64'),
    createSocket: (url) => {
      // Why: production cells require TLS; the black-box test only substitutes
      // a loopback plaintext transport while preserving the served upgrade path.
      return new NodeWebSocket(url.replace('wss:', 'ws:')) as unknown as WebSocket
    }
  })
}

function successfulClient(): PairingCandidateClient {
  return {
    sendRequest: async () => ({
      id: 'rpc-1',
      ok: true,
      result: { path: 'relay' },
      _meta: { runtimeId: 'runtime-1' }
    }),
    close: vi.fn()
  }
}

async function serveUpgradeFailure(status: number): Promise<string> {
  const server = createServer()
  server.on('upgrade', (_request, socket) => {
    socket.end(`HTTP/1.1 ${status} Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  })
  return listen(server)
}

async function serveCloseCode(code: number): Promise<string> {
  const server = createServer()
  const sockets = new WebSocketServer({ server })
  sockets.on('connection', (socket) => socket.close(code, 'host offline'))
  return listen(server)
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

function createJournal(cellUrl: string): MobileRelayPairingJournal {
  return {
    metadata: {
      v: 1,
      journalId: 'pair-1',
      offerFingerprint: 'A'.repeat(43),
      host: {
        id: 'host-1',
        name: 'Blue Whale',
        endpoint: 'ws://192.168.1.10:6768',
        publicKeyB64: Buffer.alloc(32, 7).toString('base64'),
        lastConnected: 1
      },
      relay: {
        v: 1,
        directorUrl: 'https://relay-staging.onorca.dev',
        cellUrl,
        assignmentEpoch: 7,
        relayHostId: 'AbCdEf0123_-xyZ9',
        inviteExpiresAt: 10_000,
        e2eeFraming: 2
      },
      installReqId: 'install-1',
      resumeConfirmReqId: 'confirm-1',
      pendingResumeTokenHash: 'B'.repeat(43)
    },
    secrets: {
      v: 1,
      journalId: 'pair-1',
      deviceToken: 'device-token',
      inviteToken: 'C'.repeat(43),
      pendingResumeToken: 'D'.repeat(43)
    }
  }
}

function relayFromJournal(journal: MobileRelayPairingJournal): PairingRelay {
  return {
    ...journal.metadata.relay,
    inviteToken: journal.secrets.inviteToken
  }
}
