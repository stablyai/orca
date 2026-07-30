// Peer-client saved-pairing IPC tests: a successful connect must persist the pairing so a
// fresh PeerClientService (simulating an app restart) can reconnect without the code being
// re-supplied, and only an explicit forget — never a plain disconnect — may clear it.

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
import { PeerClientService } from '../runtime/peer-client-service'
import { generateKeyPair } from '../../shared/e2ee-crypto'
import {
  serveOnePeerConnection,
  startPeerTestServer,
  waitForPeerClientState,
  makePeerPairingOffer
} from '../runtime/peer-client-test-harness'

function makeFakeStore(): Store {
  const settings = {} as GlobalSettings
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

describe('registerPeerClientHandlers saved pairing', () => {
  const servers: WebSocketServer[] = []
  const services: PeerClientService[] = []

  afterEach(async () => {
    handleMock.mockClear()
    for (const service of services.splice(0)) {
      service.destroy()
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
    const service1 = new PeerClientService()
    services.push(service1)
    registerPeerClientHandlers(service1, store)
    const handlers1 = captureHandlers()

    const code = makePeerPairingOffer(endpoint, serverKeys, 'peer-token-abc')
    const connectResult = handlers1.get('peerClient:connect')!(undefined, {
      pairingCode: code,
      displayName: 'Tester'
    })
    expect(connectResult).toEqual({ ok: true })

    // Why: nothing is persisted until the handshake actually succeeds.
    expect(store.getSettings().peerCollabSavedPairingCode).toBeUndefined()
    await waitForPeerClientState(service1, 'connected')
    expect(store.getSettings().peerCollabSavedPairingCode).toBe(code)

    // A plain disconnect must not clear the saved pairing.
    handlers1.get('peerClient:disconnect')!(undefined)
    expect(store.getSettings().peerCollabSavedPairingCode).toBe(code)

    // Simulate an app restart: a brand-new service instance, same on-disk settings.
    serveOnePeerConnection(server, serverKeys, 'peer-token-abc')
    const service2 = new PeerClientService()
    services.push(service2)
    registerPeerClientHandlers(service2, store)
    const handlers2 = captureHandlers()

    const savedInfo = handlers2.get('peerClient:getSavedPairing')!(undefined) as {
      endpoint: string | null
    } | null
    expect(savedInfo?.endpoint).toBe(endpoint)

    const reconnectResult = handlers2.get('peerClient:connectSaved')!(undefined)
    expect(reconnectResult).toEqual({ ok: true })
    await waitForPeerClientState(service2, 'connected')
  })

  it('rejects an invalid pairing code without touching the saved pairing', () => {
    const store = makeFakeStore()
    const service = new PeerClientService()
    services.push(service)
    registerPeerClientHandlers(service, store)
    const handlers = captureHandlers()

    const result = handlers.get('peerClient:connect')!(undefined, {
      pairingCode: 'not a pairing code',
      displayName: 'Tester'
    })
    expect(result).toEqual({ ok: false, reason: 'invalid_pairing_code' })
    expect(store.getSettings().peerCollabSavedPairingCode).toBeUndefined()
  })

  it('clears the saved pairing only on explicit forget', async () => {
    const { server, endpoint } = await startPeerTestServer()
    servers.push(server)
    const serverKeys = generateKeyPair()
    serveOnePeerConnection(server, serverKeys, 'peer-token-abc')

    const store = makeFakeStore()
    const service = new PeerClientService()
    services.push(service)
    registerPeerClientHandlers(service, store)
    const handlers = captureHandlers()

    const code = makePeerPairingOffer(endpoint, serverKeys, 'peer-token-abc')
    handlers.get('peerClient:connect')!(undefined, { pairingCode: code, displayName: 'Tester' })
    await waitForPeerClientState(service, 'connected')
    expect(store.getSettings().peerCollabSavedPairingCode).toBeDefined()

    const forgetResult = handlers.get('peerClient:forgetSavedPairing')!(undefined)
    expect(forgetResult).toEqual({ ok: true })
    expect(store.getSettings().peerCollabSavedPairingCode).toBeUndefined()
    expect(handlers.get('peerClient:getSavedPairing')!(undefined)).toBeNull()
  })

  it('a revoked device leaves the saved pairing intact but closed/unauthorized, ready to be forgotten', async () => {
    const { server, endpoint } = await startPeerTestServer()
    servers.push(server)
    const serverKeys = generateKeyPair()
    serveOnePeerConnection(server, serverKeys, 'expected-token')

    const store = makeFakeStore()
    const service1 = new PeerClientService()
    services.push(service1)
    registerPeerClientHandlers(service1, store)
    const handlers1 = captureHandlers()

    // Why: an offer minted with a token the (simulated) host no longer
    // recognizes mirrors a post-revoke reconnect attempt.
    const staleCode = makePeerPairingOffer(endpoint, serverKeys, 'revoked-token')
    handlers1.get('peerClient:connect')!(undefined, {
      pairingCode: staleCode,
      displayName: 'Tester'
    })
    await waitForPeerClientState(service1, 'closed')
    expect(service1.getStatus().lastErrorReason).toBe('unauthorized')
    // Why: the connect never authenticated, so nothing should have been saved.
    expect(store.getSettings().peerCollabSavedPairingCode).toBeUndefined()

    // Seed a previously-saved (now-stale) pairing directly, as if it had
    // authenticated before the host revoked the device.
    store.updateSettings({ peerCollabSavedPairingCode: staleCode })

    serveOnePeerConnection(server, serverKeys, 'expected-token')
    const service2 = new PeerClientService()
    services.push(service2)
    registerPeerClientHandlers(service2, store)
    const handlers2 = captureHandlers()

    handlers2.get('peerClient:connectSaved')!(undefined)
    await waitForPeerClientState(service2, 'closed')
    expect(service2.getStatus().lastErrorReason).toBe('unauthorized')
    expect(service2.getStatus().reconnectAttempt).toBe(0)

    handlers2.get('peerClient:forgetSavedPairing')!(undefined)
    expect(store.getSettings().peerCollabSavedPairingCode).toBeUndefined()
  })
})
