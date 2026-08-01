// Peer-client hostId-routing IPC tests: a successful connect must persist the pairing (keyed
// by hostId) so a fresh PeerClientManager (simulating an app restart) can reconnect that
// specific host without the code being re-supplied, and only an explicit forget — never a
// plain disconnect — may clear a saved pairing. Two hosts connected at once must stay
// independently addressable through every hostId-scoped handler.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebSocketServer } from 'ws'
import type { GlobalSettings } from '../../shared/types'
import type { Store } from '../persistence'

const { handleMock } = vi.hoisted(() => ({ handleMock: vi.fn() }))
vi.mock('electron', () => ({
  ipcMain: { handle: handleMock },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('../orca-profiles/profile-index-store', () => ({
  getOrcaProfileListState: () => ({ activeProfileId: null, profiles: [] })
}))

import { registerPeerClientHandlers } from './peer-client'
import { PeerClientManager } from '../runtime/peer-client-manager'
import { generateKeyPair } from '../../shared/e2ee-crypto'
import {
  serveOnePeerConnection,
  startPeerTestServer,
  waitForPeerClientState,
  makePeerPairingOffer
} from '../runtime/peer-client-test-harness'

// Why: the client toggle defaults off (see registerPeerClientHandlers' connect
// gate); existing tests exercise connect behavior itself, so seed it on here
// and cover the off case with its own dedicated store/test below.
function makeFakeStore(): Store {
  const settings = { peerCollabClientEnabled: true } as GlobalSettings
  return {
    getSettings: () => settings,
    updateSettings: (updates: Partial<GlobalSettings>) => Object.assign(settings, updates)
  } as unknown as Store
}

type Handler = (event: unknown, args?: unknown) => unknown

function captureHandlers(): Map<string, Handler> {
  const handlers = new Map<string, Handler>()
  for (const [channel, handler] of handleMock.mock.calls as [string, Handler][]) {
    handlers.set(channel, handler)
  }
  return handlers
}

function expectHostId(result: unknown): string {
  const typed = result as { ok: boolean; hostId?: string }
  expect(typed.ok).toBe(true)
  if (!typed.hostId) {
    throw new Error('expected a hostId on a successful connect result')
  }
  return typed.hostId
}

describe('registerPeerClientHandlers saved pairing', () => {
  const servers: WebSocketServer[] = []
  const managers: PeerClientManager[] = []

  afterEach(async () => {
    handleMock.mockClear()
    for (const manager of managers.splice(0)) {
      manager.destroy()
    }
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

  it('persists the pairing only once the handshake authenticates, then reconnects after a simulated restart', async () => {
    const { server, endpoint } = await startPeerTestServer()
    servers.push(server)
    const serverKeys = generateKeyPair()
    serveOnePeerConnection(server, serverKeys, 'peer-token-abc')

    const store = makeFakeStore()
    const manager1 = new PeerClientManager()
    managers.push(manager1)
    registerPeerClientHandlers(manager1, store)
    const handlers1 = captureHandlers()

    const code = makePeerPairingOffer(endpoint, serverKeys, 'peer-token-abc')
    const connectResult = handlers1.get('peerClient:connect')!(undefined, {
      pairingCode: code,
      displayName: 'Tester'
    })
    const hostId = expectHostId(connectResult)

    // Why: nothing is persisted until the handshake actually succeeds.
    expect(store.getSettings().peerCollabSavedPairings).toBeUndefined()
    await waitForPeerClientState(manager1.getService(hostId)!, 'connected')
    expect(store.getSettings().peerCollabSavedPairings).toEqual([code])

    // A plain disconnect must not clear the saved pairing.
    handlers1.get('peerClient:disconnect')!(undefined, { hostId })
    expect(store.getSettings().peerCollabSavedPairings).toEqual([code])

    // Simulate an app restart: a brand-new manager instance, same on-disk settings.
    serveOnePeerConnection(server, serverKeys, 'peer-token-abc')
    const manager2 = new PeerClientManager()
    managers.push(manager2)
    registerPeerClientHandlers(manager2, store)
    const handlers2 = captureHandlers()

    const savedList = handlers2.get('peerClient:listSavedPairings')!(undefined) as {
      hostId: string
      endpoint: string | null
    }[]
    expect(savedList).toEqual([{ hostId, endpoint }])

    const reconnectResult = handlers2.get('peerClient:connectSaved')!(undefined, { hostId })
    expect(expectHostId(reconnectResult)).toBe(hostId)
    await waitForPeerClientState(manager2.getService(hostId)!, 'connected')
  })

  it('rejects an invalid pairing code without touching the saved pairing', () => {
    const store = makeFakeStore()
    const manager = new PeerClientManager()
    managers.push(manager)
    registerPeerClientHandlers(manager, store)
    const handlers = captureHandlers()

    const result = handlers.get('peerClient:connect')!(undefined, {
      pairingCode: 'not a pairing code',
      displayName: 'Tester'
    })
    expect(result).toEqual({ ok: false, reason: 'invalid_pairing_code' })
    expect(store.getSettings().peerCollabSavedPairings).toBeUndefined()
  })

  it('clears the saved pairing only on explicit forget', async () => {
    const { server, endpoint } = await startPeerTestServer()
    servers.push(server)
    const serverKeys = generateKeyPair()
    serveOnePeerConnection(server, serverKeys, 'peer-token-abc')

    const store = makeFakeStore()
    const manager = new PeerClientManager()
    managers.push(manager)
    registerPeerClientHandlers(manager, store)
    const handlers = captureHandlers()

    const code = makePeerPairingOffer(endpoint, serverKeys, 'peer-token-abc')
    const hostId = expectHostId(
      handlers.get('peerClient:connect')!(undefined, { pairingCode: code, displayName: 'Tester' })
    )
    await waitForPeerClientState(manager.getService(hostId)!, 'connected')
    expect(store.getSettings().peerCollabSavedPairings).toEqual([code])

    const forgetResult = handlers.get('peerClient:forgetSavedPairing')!(undefined, { hostId })
    expect(forgetResult).toEqual({ ok: true })
    expect(store.getSettings().peerCollabSavedPairings).toEqual([])
    expect(handlers.get('peerClient:listSavedPairings')!(undefined)).toEqual([])
  })

  it('a revoked device leaves the saved pairing intact but closed/unauthorized, ready to be forgotten', async () => {
    const { server, endpoint } = await startPeerTestServer()
    servers.push(server)
    const serverKeys = generateKeyPair()
    serveOnePeerConnection(server, serverKeys, 'expected-token')

    const store = makeFakeStore()
    const manager1 = new PeerClientManager()
    managers.push(manager1)
    registerPeerClientHandlers(manager1, store)
    const handlers1 = captureHandlers()

    // Why: an offer minted with a token the (simulated) host no longer
    // recognizes mirrors a post-revoke reconnect attempt.
    const staleCode = makePeerPairingOffer(endpoint, serverKeys, 'revoked-token')
    const hostId = expectHostId(
      handlers1.get('peerClient:connect')!(undefined, {
        pairingCode: staleCode,
        displayName: 'Tester'
      })
    )
    await waitForPeerClientState(manager1.getService(hostId)!, 'closed')
    expect(manager1.getService(hostId)!.getStatus().lastErrorReason).toBe('unauthorized')
    // Why: the connect never authenticated, so nothing should have been saved.
    expect(store.getSettings().peerCollabSavedPairings).toBeUndefined()

    // Seed a previously-saved (now-stale) pairing directly, as if it had
    // authenticated before the host revoked the device.
    store.updateSettings({ peerCollabSavedPairings: [staleCode] })

    serveOnePeerConnection(server, serverKeys, 'expected-token')
    const manager2 = new PeerClientManager()
    managers.push(manager2)
    registerPeerClientHandlers(manager2, store)
    const handlers2 = captureHandlers()

    handlers2.get('peerClient:connectSaved')!(undefined, { hostId })
    await waitForPeerClientState(manager2.getService(hostId)!, 'closed')
    expect(manager2.getService(hostId)!.getStatus().lastErrorReason).toBe('unauthorized')
    expect(manager2.getService(hostId)!.getStatus().reconnectAttempt).toBe(0)

    handlers2.get('peerClient:forgetSavedPairing')!(undefined, { hostId })
    expect(store.getSettings().peerCollabSavedPairings).toEqual([])
  })
})

describe('registerPeerClientHandlers multi-host routing', () => {
  const servers: WebSocketServer[] = []
  const managers: PeerClientManager[] = []

  afterEach(async () => {
    handleMock.mockClear()
    for (const manager of managers.splice(0)) {
      manager.destroy()
    }
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

  type TwoHostFixture = {
    hostA: string
    hostB: string
    serverB: WebSocketServer
    keysB: ReturnType<typeof generateKeyPair>
  }

  async function connectTwoHosts(
    manager: PeerClientManager,
    handlers: Map<string, Handler>
  ): Promise<TwoHostFixture> {
    const { server: serverA, endpoint: endpointA } = await startPeerTestServer()
    const { server: serverB, endpoint: endpointB } = await startPeerTestServer()
    servers.push(serverA, serverB)
    const keysA = generateKeyPair()
    const keysB = generateKeyPair()
    serveOnePeerConnection(serverA, keysA, 'token-a')
    serveOnePeerConnection(serverB, keysB, 'token-b')

    const hostA = expectHostId(
      handlers.get('peerClient:connect')!(undefined, {
        pairingCode: makePeerPairingOffer(endpointA, keysA, 'token-a'),
        displayName: 'Tester'
      })
    )
    const hostB = expectHostId(
      handlers.get('peerClient:connect')!(undefined, {
        pairingCode: makePeerPairingOffer(endpointB, keysB, 'token-b'),
        displayName: 'Tester'
      })
    )
    await Promise.all([
      waitForPeerClientState(manager.getService(hostA)!, 'connected'),
      waitForPeerClientState(manager.getService(hostB)!, 'connected')
    ])
    return { hostA, hostB, serverB, keysB }
  }

  it('routes listHostTerminals to the host that owns the given hostId, and rejects an unknown hostId', async () => {
    const store = makeFakeStore()
    const manager = new PeerClientManager()
    managers.push(manager)
    registerPeerClientHandlers(manager, store)
    const handlers = captureHandlers()

    const { hostA, hostB } = await connectTwoHosts(manager, handlers)

    const resultA = (await handlers.get('peerClient:listHostTerminals')!(undefined, {
      hostId: hostA
    })) as { ok: boolean }
    const resultB = (await handlers.get('peerClient:listHostTerminals')!(undefined, {
      hostId: hostB
    })) as { ok: boolean }
    expect(resultA.ok).toBe(true)
    expect(resultB.ok).toBe(true)

    const unknown = await handlers.get('peerClient:listHostTerminals')!(undefined, {
      hostId: 'not-a-connected-host'
    })
    expect(unknown).toEqual({ ok: false, reason: 'host_not_found' })
  })

  it('disconnect({hostId}) closes only that host, leaving the other connected', async () => {
    const store = makeFakeStore()
    const manager = new PeerClientManager()
    managers.push(manager)
    registerPeerClientHandlers(manager, store)
    const handlers = captureHandlers()

    const { hostA, hostB } = await connectTwoHosts(manager, handlers)

    handlers.get('peerClient:disconnect')!(undefined, { hostId: hostA })
    await waitForPeerClientState(manager.getService(hostA)!, 'closed')

    const statuses = handlers.get('peerClient:getStatuses')!(undefined) as {
      hostId: string
      state: string
    }[]
    expect(statuses.find((s) => s.hostId === hostA)?.state).toBe('closed')
    expect(statuses.find((s) => s.hostId === hostB)?.state).toBe('connected')
  })

  it('connectSaved({hostId}) reconnects the specific saved host among several saved pairings', async () => {
    const store = makeFakeStore()
    const manager1 = new PeerClientManager()
    managers.push(manager1)
    registerPeerClientHandlers(manager1, store)
    const handlers1 = captureHandlers()

    const { hostB, serverB, keysB } = await connectTwoHosts(manager1, handlers1)
    expect(store.getSettings().peerCollabSavedPairings).toHaveLength(2)

    // Why: serveOnePeerConnection only answers one connection; re-arm hostB's
    // server so the simulated-restart reconnect below has a peer to shake hands with.
    serveOnePeerConnection(serverB, keysB, 'token-b')

    // Simulate a restart: fresh manager, same persisted settings.
    const manager2 = new PeerClientManager()
    managers.push(manager2)
    registerPeerClientHandlers(manager2, store)
    const handlers2 = captureHandlers()

    const reconnectResult = handlers2.get('peerClient:connectSaved')!(undefined, {
      hostId: hostB
    })
    expect(expectHostId(reconnectResult)).toBe(hostB)
    await waitForPeerClientState(manager2.getService(hostB)!, 'connected')
  })

  it('setClientEnabled(false) disconnects every connected host', async () => {
    const store = makeFakeStore()
    const manager = new PeerClientManager()
    managers.push(manager)
    registerPeerClientHandlers(manager, store)
    const handlers = captureHandlers()

    const { hostA, hostB } = await connectTwoHosts(manager, handlers)

    const setResult = handlers.get('peerClient:setClientEnabled')!(undefined, { enabled: false })
    expect(setResult).toEqual({ enabled: false })
    await Promise.all([
      waitForPeerClientState(manager.getService(hostA)!, 'closed'),
      waitForPeerClientState(manager.getService(hostB)!, 'closed')
    ])
  })
})

describe('registerPeerClientHandlers client on/off toggle', () => {
  const managers: PeerClientManager[] = []

  afterEach(() => {
    handleMock.mockClear()
    for (const manager of managers.splice(0)) {
      manager.destroy()
    }
  })

  function makeDisabledStore(): Store {
    const settings = {} as GlobalSettings
    return {
      getSettings: () => settings,
      updateSettings: (updates: Partial<GlobalSettings>) => Object.assign(settings, updates)
    } as unknown as Store
  }

  it('rejects connect with client_disabled while the client toggle is off (default)', () => {
    const store = makeDisabledStore()
    const manager = new PeerClientManager()
    managers.push(manager)
    registerPeerClientHandlers(manager, store)
    const handlers = captureHandlers()

    const result = handlers.get('peerClient:connect')!(undefined, {
      pairingCode: 'anything',
      displayName: 'Tester'
    })
    expect(result).toEqual({ ok: false, reason: 'client_disabled' })
  })

  it('rejects connectSaved with client_disabled while the client toggle is off', () => {
    const store = makeDisabledStore()
    store.updateSettings({ peerCollabSavedPairings: ['saved-code'] })
    const manager = new PeerClientManager()
    managers.push(manager)
    registerPeerClientHandlers(manager, store)
    const handlers = captureHandlers()

    const result = handlers.get('peerClient:connectSaved')!(undefined, { hostId: 'anything' })
    expect(result).toEqual({ ok: false, reason: 'client_disabled' })
  })

  it('disconnects the live service when the toggle is switched off', async () => {
    const { server, endpoint } = await startPeerTestServer()
    const serverKeys = generateKeyPair()
    serveOnePeerConnection(server, serverKeys, 'peer-token-abc')

    const store = makeFakeStore()
    const manager = new PeerClientManager()
    managers.push(manager)
    registerPeerClientHandlers(manager, store)
    const handlers = captureHandlers()

    const code = makePeerPairingOffer(endpoint, serverKeys, 'peer-token-abc')
    const hostId = expectHostId(
      handlers.get('peerClient:connect')!(undefined, { pairingCode: code, displayName: 'Tester' })
    )
    await waitForPeerClientState(manager.getService(hostId)!, 'connected')

    const setResult = handlers.get('peerClient:setClientEnabled')!(undefined, { enabled: false })
    expect(setResult).toEqual({ enabled: false })
    await waitForPeerClientState(manager.getService(hostId)!, 'closed')
    expect(store.getSettings().peerCollabClientEnabled).toBe(false)

    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
})
