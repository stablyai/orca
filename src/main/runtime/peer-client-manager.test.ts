import { afterEach, describe, expect, it } from 'vitest'
import type { WebSocketServer } from 'ws'
import {
  PeerClientManager,
  readSavedPeerPairings,
  upsertSavedPeerPairing
} from './peer-client-manager'
import { generateKeyPair, publicKeyToBase64 } from '../../shared/e2ee-crypto'
import {
  makePeerPairingOffer,
  serveOnePeerConnection,
  startPeerTestServer as startServer,
  waitForPeerClientState as waitForState
} from './peer-client-test-harness'

describe('PeerClientManager', () => {
  const servers: WebSocketServer[] = []
  let manager: PeerClientManager | null = null

  afterEach(async () => {
    manager?.destroy()
    manager = null
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            for (const client of server.clients) {
              client.terminate()
            }
            server.close(() => resolve())
          })
      )
    )
  })

  async function startHost(deviceToken: string) {
    const { server, endpoint } = await startServer()
    servers.push(server)
    const keys = generateKeyPair()
    serveOnePeerConnection(server, keys, deviceToken)
    return { server, endpoint, keys, hostId: publicKeyToBase64(keys.publicKey) }
  }

  it('connects to two distinct hosts concurrently, each independently usable', async () => {
    manager = new PeerClientManager()
    const hostA = await startHost('token-a')
    const hostB = await startHost('token-b')
    const codeA = makePeerPairingOffer(hostA.endpoint, hostA.keys, 'token-a')
    const codeB = makePeerPairingOffer(hostB.endpoint, hostB.keys, 'token-b')

    const resultA = manager.connect(codeA)
    const resultB = manager.connect(codeB)
    expect(resultA).toEqual({ ok: true, hostId: hostA.hostId })
    expect(resultB).toEqual({ ok: true, hostId: hostB.hostId })

    await Promise.all([
      waitForState(manager.getService(hostA.hostId)!, 'connected'),
      waitForState(manager.getService(hostB.hostId)!, 'connected')
    ])

    const statuses = manager.getStatuses()
    expect(statuses).toHaveLength(2)
    expect(statuses.every((status) => status.state === 'connected')).toBe(true)

    await expect(manager.getService(hostA.hostId)!.listHostTerminals()).resolves.toEqual({
      terminals: []
    })
    await expect(manager.getService(hostB.hostId)!.listHostTerminals()).resolves.toEqual({
      terminals: []
    })
  })

  it('reuses the existing instance and replaces the connection on a repeat connect to the same host', async () => {
    manager = new PeerClientManager()
    const host = await startHost('token-a')
    const code = makePeerPairingOffer(host.endpoint, host.keys, 'token-a')

    expect(manager.connect(code)).toEqual({ ok: true, hostId: host.hostId })
    await waitForState(manager.getService(host.hostId)!, 'connected')
    const firstInstance = manager.getService(host.hostId)

    // Why: the harness server only serves one connection per registration.
    serveOnePeerConnection(host.server, host.keys, 'token-a')
    expect(manager.connect(code)).toEqual({ ok: true, hostId: host.hostId })
    await waitForState(manager.getService(host.hostId)!, 'connected')

    expect(manager.getStatuses()).toHaveLength(1)
    expect(manager.getService(host.hostId)).toBe(firstInstance)
  })

  it('disconnect(hostId) only closes that host, leaving the other connected', async () => {
    manager = new PeerClientManager()
    const hostA = await startHost('token-a')
    const hostB = await startHost('token-b')
    manager.connect(makePeerPairingOffer(hostA.endpoint, hostA.keys, 'token-a'))
    manager.connect(makePeerPairingOffer(hostB.endpoint, hostB.keys, 'token-b'))
    await Promise.all([
      waitForState(manager.getService(hostA.hostId)!, 'connected'),
      waitForState(manager.getService(hostB.hostId)!, 'connected')
    ])

    manager.disconnect(hostA.hostId)
    await waitForState(manager.getService(hostA.hostId)!, 'closed')

    expect(manager.getService(hostA.hostId)!.getStatus().state).toBe('closed')
    expect(manager.getService(hostB.hostId)!.getStatus().state).toBe('connected')
  })

  it('disconnectAll closes every tracked host', async () => {
    manager = new PeerClientManager()
    const hostA = await startHost('token-a')
    const hostB = await startHost('token-b')
    manager.connect(makePeerPairingOffer(hostA.endpoint, hostA.keys, 'token-a'))
    manager.connect(makePeerPairingOffer(hostB.endpoint, hostB.keys, 'token-b'))
    await Promise.all([
      waitForState(manager.getService(hostA.hostId)!, 'connected'),
      waitForState(manager.getService(hostB.hostId)!, 'connected')
    ])

    manager.disconnectAll()
    await Promise.all([
      waitForState(manager.getService(hostA.hostId)!, 'closed'),
      waitForState(manager.getService(hostB.hostId)!, 'closed')
    ])

    expect(manager.getStatuses().every((status) => status.state === 'closed')).toBe(true)
  })

  it('fans out onStatusChange with the originating hostId', async () => {
    manager = new PeerClientManager()
    const host = await startHost('token-a')
    const seen: { hostId: string; state: string }[] = []
    manager.onStatusChange((hostId, status) => seen.push({ hostId, state: status.state }))

    manager.connect(makePeerPairingOffer(host.endpoint, host.keys, 'token-a'))
    await waitForState(manager.getService(host.hostId)!, 'connected')

    expect(seen.some((entry) => entry.hostId === host.hostId && entry.state === 'connected')).toBe(
      true
    )
  })
})

describe('saved peer pairing migration and upsert', () => {
  it('leaves the array untouched when there is no legacy value', () => {
    expect(readSavedPeerPairings(['code-a'], undefined)).toEqual(['code-a'])
  })

  it('folds a legacy single value into the array when present', () => {
    expect(readSavedPeerPairings(undefined, 'legacy-code')).toEqual(['legacy-code'])
    expect(readSavedPeerPairings([], 'legacy-code')).toEqual(['legacy-code'])
  })

  it('does not duplicate the legacy value if its hostId is already in the array', () => {
    const serverKeys = generateKeyPair()
    const code = makePeerPairingOffer('ws://127.0.0.1:1', serverKeys, 'token')
    expect(readSavedPeerPairings([code], code)).toEqual([code])
  })

  it('upsert appends a new host and replaces an existing entry for the same host', () => {
    const keysA = generateKeyPair()
    const keysB = generateKeyPair()
    const codeA1 = makePeerPairingOffer('ws://127.0.0.1:1', keysA, 'token')
    const codeA2 = makePeerPairingOffer('ws://127.0.0.1:2', keysA, 'token')
    const codeB = makePeerPairingOffer('ws://127.0.0.1:3', keysB, 'token')

    const afterFirst = upsertSavedPeerPairing([], codeA1)
    expect(afterFirst).toEqual([codeA1])

    const afterSecondHost = upsertSavedPeerPairing(afterFirst, codeB)
    expect(afterSecondHost).toEqual([codeA1, codeB])

    const afterReplace = upsertSavedPeerPairing(afterSecondHost, codeA2)
    expect(afterReplace).toEqual([codeB, codeA2])
  })
})
