// Why: Phase 8 verification — exercises the real WebSocket/E2EE transport (OrcaRuntimeRpcServer
// + PeerClientService, unmodified) with a fake terminal backend, since no existing test spins up
// a real node-pty process for RPC-level terminal tests (see terminal-multiplex.test.ts,
// terminal-send.test.ts). Driver-arbitration and subscription bookkeeping are exercised for real
// (they are plain in-memory state on OrcaRuntimeService); only the PTY write/read surface is faked.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import type { OrcaRuntimeService } from './orca-runtime'
import { PeerClientService } from './peer-client-service'
import type { PeerTerminalStreamEvent } from '../../shared/peer-terminal-stream-event'
import type { RuntimeTerminalDriverState } from '../../shared/runtime-types'
import * as relayHttpClient from './relay/relay-http-client'
import { isPeerTerminalGranted } from './rpc/peer-terminal-grant-guard'

const TEST_TERMINAL = 'term-1'
const UNGRANTED_TERMINAL = 'term-2'

// Why: the minimal terminal-subscribe surface terminal.ts's binary-stream path touches for a
// non-mobile (peer) client with a viewport — enumerated by reading that path end to end so no
// hidden real-pty dependency (e.g. applyRemoteDesktopLayout) leaks in through a partially-real
// OrcaRuntimeService instance.
function buildFakeTerminalRuntime(): {
  runtime: OrcaRuntimeService
  pushOutput: (terminal: string, data: string) => void
  inputLog: { terminal: string; text: string }[]
  activeSubscriptionCount: () => number
} {
  const ptyIdFor = (terminal: string): string => `pty:${terminal}`
  const dataListeners = new Map<string, Set<(data: string) => void>>()
  const subscriptionCleanups = new Map<string, () => void>()
  const subscriptionsByConnection = new Map<string, Set<string>>()
  const driverByPty = new Map<string, RuntimeTerminalDriverState>()
  let peerInputFloorExclusive = false
  const inputLog: { terminal: string; text: string }[] = []

  const runtime = {
    // --- OrcaRuntimeRpcServer direct calls ---
    getRuntimeId: () => 'test-runtime',
    getStartedAt: () => 0,
    getStatus: () => ({ graphStatus: 'ready' }),
    forgetClientNavigationState: () => {},
    cancelMobileDictationForConnection: () => {},
    onClientDisconnected: () => {},
    resolveLiveLeafForHandle: (handle: string) =>
      handle === TEST_TERMINAL || handle === UNGRANTED_TERMINAL
        ? { ptyId: ptyIdFor(handle) }
        : null,
    listTerminals: async () => ({
      terminals: [
        {
          handle: TEST_TERMINAL,
          ptyId: ptyIdFor(TEST_TERMINAL),
          worktreeId: 'wt-1',
          worktreePath: '/granted/worktree',
          branch: 'main',
          tabId: 'tab-1',
          leafId: 'leaf-1',
          title: 'granted title',
          connected: true,
          writable: true,
          lastOutputAt: null,
          preview: ''
        },
        {
          handle: UNGRANTED_TERMINAL,
          ptyId: ptyIdFor(UNGRANTED_TERMINAL),
          worktreeId: 'wt-2',
          worktreePath: '/secret/worktree',
          branch: 'main',
          tabId: 'tab-2',
          leafId: 'leaf-2',
          title: 'secret title',
          connected: true,
          writable: true,
          lastOutputAt: null,
          preview: ''
        }
      ],
      totalCount: 2,
      truncated: false
    }),
    setPeerInputFloorExclusive: (enabled: boolean) => {
      peerInputFloorExclusive = enabled
    },
    isPeerInputFloorExclusive: () => peerInputFloorExclusive,
    // Why: mirrors this.tabs' resolved title (customTitle/quickCommandLabel/generatedTitle),
    // deliberately distinct from the 'granted title'/'secret title' stubs above so tests can
    // tell terminal.list is preferring this over the raw live title.
    getSyncedTabTitle: (tabId: string) => (tabId === 'tab-1' ? 'resolved tab title' : null),

    // --- subscription bookkeeping (mirrors orca-runtime.ts's Map-based real logic) ---
    registerSubscriptionCleanup: (id: string, cleanup: () => void, connectionId?: string) => {
      subscriptionCleanups.set(id, cleanup)
      if (connectionId) {
        const set = subscriptionsByConnection.get(connectionId) ?? new Set<string>()
        set.add(id)
        subscriptionsByConnection.set(connectionId, set)
      }
    },
    cleanupSubscription: (id: string) => {
      subscriptionCleanups.get(id)?.()
      subscriptionCleanups.delete(id)
      for (const set of subscriptionsByConnection.values()) {
        set.delete(id)
      }
    },
    getSubscriptionIdsForConnection: (connectionId: string) =>
      Array.from(subscriptionsByConnection.get(connectionId) ?? []),
    cleanupSubscriptionsForConnection: (connectionId: string) => {
      for (const id of subscriptionsByConnection.get(connectionId) ?? []) {
        subscriptionCleanups.get(id)?.()
        subscriptionCleanups.delete(id)
      }
      subscriptionsByConnection.delete(connectionId)
    },

    // --- input-floor arbitration (peer path only: claimInputFloor's plain branch, no
    // soft-leave/generation bookkeeping since that's mobile-only and unreachable from isPeer) ---
    getDriver: (ptyId: string): RuntimeTerminalDriverState =>
      driverByPty.get(ptyId) ?? { kind: 'idle' },
    beginInputFloor: (ptyId: string, clientId: string) => {
      const previous = driverByPty.get(ptyId) ?? { kind: 'idle' as const }
      driverByPty.set(ptyId, { kind: 'peer', clientId })
      let settled = false
      return {
        commit: async () => {
          settled = true
        },
        rollback: () => {
          if (settled) {
            return
          }
          settled = true
          driverByPty.set(ptyId, previous)
        }
      }
    },
    releaseInputFloorIfHeldBy: (ptyId: string, clientId: string) => {
      const driver = driverByPty.get(ptyId)
      if (driver?.kind === 'peer' && driver.clientId === clientId) {
        driverByPty.set(ptyId, { kind: 'idle' })
      }
    },

    // --- fake terminal I/O ---
    resolveLeafForHandle: (handle: string) => ({ ptyId: ptyIdFor(handle) }),
    readTerminal: async () => ({ tail: [], truncated: false }),
    serializeTerminalBuffer: async () => ({ data: '', cols: 80, rows: 24 }),
    getTerminalSize: () => ({ cols: 80, rows: 24 }),
    getMobileDisplayMode: () => 'desktop' as const,
    getLayout: () => ({ seq: 1 }),
    subscribeToTerminalData: (ptyId: string, listener: (data: string) => void) => {
      const set = dataListeners.get(ptyId) ?? new Set()
      set.add(listener)
      dataListeners.set(ptyId, set)
      return () => set.delete(listener)
    },
    subscribeToTerminalResize: () => () => {},
    subscribeToFitOverrideChanges: () => () => {},
    registerRemoteTerminalViewSubscriber: () => () => {},
    updateRemoteDesktopViewer: async () => true,
    unregisterRemoteDesktopViewer: async () => true,
    // Why: never resolves — mirrors terminal-multiplex.test.ts's default stub; the test-driven
    // subscription cleanup path (registerSubscriptionCleanup) is what actually tears streams down.
    waitForTerminal: () => new Promise(() => {}),
    sendTerminal: async (
      terminal: string,
      action: { text?: string },
      options?: {
        reserveWrite?: (ptyId: string) => void
        afterWrite?: (ptyId: string) => void | Promise<void>
      }
    ) => {
      const ptyId = ptyIdFor(terminal)
      options?.reserveWrite?.(ptyId)
      inputLog.push({ terminal, text: action.text ?? '' })
      await options?.afterWrite?.(ptyId)
      return { handle: terminal, accepted: true, bytesWritten: (action.text ?? '').length }
    }
  } as unknown as OrcaRuntimeService

  return {
    runtime,
    pushOutput: (terminal, data) => {
      for (const listener of dataListeners.get(ptyIdFor(terminal)) ?? []) {
        listener(data)
      }
    },
    inputLog,
    activeSubscriptionCount: () => subscriptionCleanups.size
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting for condition')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function startPeerHost(
  // Why: existing fan-out/input/cleanup tests don't exercise grant
  // enforcement, so default to granting the one terminal they use.
  options: { grantedTerminals?: string[] } = { grantedTerminals: [TEST_TERMINAL] }
): Promise<{
  server: OrcaRuntimeRpcServer
  runtime: ReturnType<typeof buildFakeTerminalRuntime>
  pairingUrl: string
  deviceId: string
}> {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-peer-collab-'))
  const fake = buildFakeTerminalRuntime()
  const server = new OrcaRuntimeRpcServer({
    runtime: fake.runtime,
    userDataPath,
    enableWebSocket: true,
    wsPort: 0
  })
  await server.start()
  server.setPeerHostingEnabled(true)
  const offer = server.createPairingOffer({
    address: '127.0.0.1',
    name: 'peer',
    scope: 'peer',
    rotate: true
  })
  if (!offer.available) {
    throw new Error('peer pairing offer unavailable')
  }
  server.setGrantedTerminals(offer.deviceId, options.grantedTerminals ?? [])
  return { server, runtime: fake, pairingUrl: offer.pairingUrl, deviceId: offer.deviceId }
}

// Why: a second real participant is a second pairing code (distinct deviceId)
// against the same host — reusing one pairingUrl for two clients is exactly
// the duplicate-connection scenario the host now rejects, so multi-client
// tests need genuinely distinct devices to exercise fan-out/cleanup instead.
function mintSecondPeerPairingUrl(
  server: OrcaRuntimeRpcServer,
  grantedTerminals: string[] = [TEST_TERMINAL]
): string {
  const offer = server.createPairingOffer({
    address: '127.0.0.1',
    name: 'peer-2',
    scope: 'peer',
    rotate: true
  })
  if (!offer.available) {
    throw new Error('second peer pairing offer unavailable')
  }
  server.setGrantedTerminals(offer.deviceId, grantedTerminals)
  return offer.pairingUrl
}

function makeClient(
  clients: PeerClientService[],
  pairingUrl: string,
  displayName: string
): PeerClientService {
  const client = new PeerClientService()
  clients.push(client)
  const connected = client.connect(pairingUrl, displayName)
  expect(connected).toEqual({ ok: true })
  return client
}

async function connectedClient(
  clients: PeerClientService[],
  pairingUrl: string,
  displayName: string
): Promise<PeerClientService> {
  const client = makeClient(clients, pairingUrl, displayName)
  await waitFor(() => client.getStatus().state === 'connected')
  return client
}

function subscribeAndAwait(
  client: PeerClientService,
  events: PeerTerminalStreamEvent[]
): { requestId: string } {
  const result = client.subscribeTerminal(TEST_TERMINAL, { cols: 80, rows: 24 }, (event) => {
    events.push(event)
  })
  expect(result.ok).toBe(true)
  if (!result.ok) {
    throw new Error(result.reason)
  }
  return { requestId: result.requestId }
}

describe('peer-collab terminal session (host + 2 clients, real WS)', () => {
  const clients: PeerClientService[] = []
  const servers: OrcaRuntimeRpcServer[] = []

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.destroy()
    }
    for (const server of servers.splice(0)) {
      await server.stop()
    }
    vi.restoreAllMocks()
  })

  it('fans terminal output out to every subscribed client', async () => {
    const { server, runtime, pairingUrl } = await startPeerHost()
    servers.push(server)

    const clientA = await connectedClient(clients, pairingUrl, 'Client A')
    const clientB = await connectedClient(clients, mintSecondPeerPairingUrl(server), 'Client B')
    const eventsA: PeerTerminalStreamEvent[] = []
    const eventsB: PeerTerminalStreamEvent[] = []
    subscribeAndAwait(clientA, eventsA)
    subscribeAndAwait(clientB, eventsB)

    await waitFor(() => eventsA.some((e) => e.type === 'subscribed'))
    await waitFor(() => eventsB.some((e) => e.type === 'subscribed'))

    runtime.pushOutput(TEST_TERMINAL, 'hello from host')

    await waitFor(() => eventsA.some((e) => e.type === 'output'))
    await waitFor(() => eventsB.some((e) => e.type === 'output'))
    expect(eventsA.find((e) => e.type === 'output')).toEqual({
      type: 'output',
      data: 'hello from host'
    })
    expect(eventsB.find((e) => e.type === 'output')).toEqual({
      type: 'output',
      data: 'hello from host'
    })
  })

  it("routes a client's typed input to the host terminal", async () => {
    const { server, runtime, pairingUrl } = await startPeerHost()
    servers.push(server)

    const clientA = await connectedClient(clients, pairingUrl, 'Client A')
    const eventsA: PeerTerminalStreamEvent[] = []
    const { requestId } = subscribeAndAwait(clientA, eventsA)
    await waitFor(() => eventsA.some((e) => e.type === 'subscribed'))

    expect(clientA.sendTerminalInput(requestId, 'ls\n')).toBe(true)

    await waitFor(() => runtime.inputLog.length === 1)
    expect(runtime.inputLog[0]).toEqual({ terminal: TEST_TERMINAL, text: 'ls\n' })
  })

  it("blocks other participants' input while a driver holds the exclusive floor", async () => {
    const { server, runtime, pairingUrl } = await startPeerHost()
    servers.push(server)
    server.setPeerInputFloorExclusive(true)

    const clientA = await connectedClient(clients, pairingUrl, 'Client A')
    const clientB = await connectedClient(clients, mintSecondPeerPairingUrl(server), 'Client B')
    const eventsA: PeerTerminalStreamEvent[] = []
    const eventsB: PeerTerminalStreamEvent[] = []
    const { requestId: requestIdA } = subscribeAndAwait(clientA, eventsA)
    const { requestId: requestIdB } = subscribeAndAwait(clientB, eventsB)
    await waitFor(() => eventsA.some((e) => e.type === 'subscribed'))
    await waitFor(() => eventsB.some((e) => e.type === 'subscribed'))

    // A types first and takes the floor.
    clientA.sendTerminalInput(requestIdA, 'a-owns-the-floor\n')
    await waitFor(() => runtime.inputLog.length === 1)

    // B's input must be dropped while A is the driver — give it a chance to
    // land and confirm it never reaches the host.
    clientB.sendTerminalInput(requestIdB, 'b-should-be-blocked\n')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(runtime.inputLog).toEqual([{ terminal: TEST_TERMINAL, text: 'a-owns-the-floor\n' }])
  })

  it('keeps a newer subscription alive when an older one for the same terminal unsubscribes', async () => {
    const { server, runtime, pairingUrl } = await startPeerHost()
    servers.push(server)

    const clientA = await connectedClient(clients, pairingUrl, 'Client A')
    const firstEvents: PeerTerminalStreamEvent[] = []
    const secondEvents: PeerTerminalStreamEvent[] = []
    // Same terminal, same client: the server keys the subscription by
    // `${terminal}:${clientId}`, which is exactly what React StrictMode's
    // mount -> unmount -> remount produces in RemoteTerminalPanel.
    const { requestId: firstRequestId } = subscribeAndAwait(clientA, firstEvents)
    await waitFor(() => firstEvents.some((e) => e.type === 'subscribed'))
    const secondResult = clientA.subscribeTerminal(
      TEST_TERMINAL,
      { cols: 80, rows: 24 },
      (event) => {
        secondEvents.push(event)
      }
    )
    expect(secondResult.ok).toBe(true)
    await waitFor(() => secondEvents.some((e) => e.type === 'subscribed'))

    clientA.unsubscribeTerminal(firstRequestId)
    await new Promise((resolve) => setTimeout(resolve, 50))

    runtime.pushOutput(TEST_TERMINAL, 'after-unsub')
    await waitFor(() => secondEvents.some((e) => e.type === 'output' && e.data === 'after-unsub'))
    expect(secondEvents.some((e) => e.type === 'end')).toBe(false)
  })

  it("cleans up a client's subscriptions on graceful disconnect without affecting the other client", async () => {
    const { server, runtime, pairingUrl } = await startPeerHost()
    servers.push(server)

    const clientA = await connectedClient(clients, pairingUrl, 'Client A')
    const clientB = await connectedClient(clients, mintSecondPeerPairingUrl(server), 'Client B')
    const eventsA: PeerTerminalStreamEvent[] = []
    const eventsB: PeerTerminalStreamEvent[] = []
    subscribeAndAwait(clientA, eventsA)
    subscribeAndAwait(clientB, eventsB)
    await waitFor(() => eventsA.some((e) => e.type === 'subscribed'))
    await waitFor(() => eventsB.some((e) => e.type === 'subscribed'))
    await waitFor(() => server.listConnectedPeerClients().length === 2)
    await waitFor(() => runtime.activeSubscriptionCount() === 2)

    clientB.disconnect()

    await waitFor(() => server.listConnectedPeerClients().length === 1)
    await waitFor(() => runtime.activeSubscriptionCount() === 1)

    runtime.pushOutput(TEST_TERMINAL, 'still alive')
    await waitFor(() => eventsA.some((e) => e.type === 'output' && e.data === 'still alive'))
  })

  it('reports the subscribed terminal handle, not the raw composite subscription id', async () => {
    const { server, runtime, pairingUrl } = await startPeerHost()
    servers.push(server)

    const clientA = await connectedClient(clients, pairingUrl, 'Client A')
    const eventsA: PeerTerminalStreamEvent[] = []
    subscribeAndAwait(clientA, eventsA)
    await waitFor(() => eventsA.some((e) => e.type === 'subscribed'))
    await waitFor(() => server.listConnectedPeerClients().length === 1)

    const connectionId = server.listConnectedPeerClients()[0]?.connectionId
    if (!connectionId) {
      throw new Error('expected a connected peer client')
    }
    // Why: nativeChat.subscribe also keys by `nativeChat:${connectionId}:${token}`,
    // a colon-bearing id that is not a terminal handle — it must never be
    // reported as a subscribed terminal.
    runtime.runtime.registerSubscriptionCleanup(
      `nativeChat:${connectionId}:token-1`,
      () => {},
      connectionId
    )

    const [connected] = server.listConnectedPeerClients()
    // Why: the RPC layer keys the subscription cleanup as `${terminal}:${clientId}`
    // so per-client streams don't evict each other — this must resolve back to
    // the bare handle for viewer badges/presence gating, never the composite id.
    expect(connected?.subscribedTerminals).toEqual([TEST_TERMINAL])
  })

  it("persists the client's handshake display name to the device registry on connect", async () => {
    const { server, pairingUrl, deviceId } = await startPeerHost()
    servers.push(server)

    await connectedClient(clients, pairingUrl, 'slowkuma-3')

    await waitFor(
      () => server.getDeviceRegistry()?.getDevice(deviceId)?.lastConnectedName === 'slowkuma-3'
    )
    expect(server.getDeviceRegistry()?.getDevice(deviceId)?.lastConnectedName).toBe('slowkuma-3')
  })
})

describe('peer-collab duplicate pairing-code connection', () => {
  const clients: PeerClientService[] = []
  const servers: OrcaRuntimeRpcServer[] = []

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.destroy()
    }
    for (const server of servers.splice(0)) {
      await server.stop()
    }
  })

  it('rejects a second client pasting the same pairing code while the first stays connected', async () => {
    const { server, pairingUrl } = await startPeerHost()
    servers.push(server)

    const clientA = new PeerClientService()
    clients.push(clientA)
    expect(clientA.connect(pairingUrl, 'Client A')).toEqual({ ok: true })
    await waitFor(() => clientA.getStatus().state === 'connected')

    const clientB = new PeerClientService()
    clients.push(clientB)
    expect(clientB.connect(pairingUrl, 'Client B')).toEqual({ ok: true })
    await waitFor(() => clientB.getStatus().state === 'closed')

    expect(clientB.getStatus().lastErrorReason).toBe('duplicate_connection')
    // Why: the rejection must not flip into a retry loop against a
    // guaranteed-repeat rejection.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(clientB.getStatus().state).toBe('closed')

    expect(clientA.getStatus().state).toBe('connected')
    expect(server.listConnectedPeerClients().length).toBe(1)
  })

  it('allows a fresh connection with the same pairing code once the first client disconnects', async () => {
    const { server, pairingUrl } = await startPeerHost()
    servers.push(server)

    const clientA = new PeerClientService()
    clients.push(clientA)
    expect(clientA.connect(pairingUrl, 'Client A')).toEqual({ ok: true })
    await waitFor(() => clientA.getStatus().state === 'connected')

    clientA.disconnect()
    await waitFor(() => server.listConnectedPeerClients().length === 0)

    const clientB = new PeerClientService()
    clients.push(clientB)
    expect(clientB.connect(pairingUrl, 'Client B')).toEqual({ ok: true })
    await waitFor(() => clientB.getStatus().state === 'connected')

    expect(clientB.getStatus().lastErrorReason).toBeNull()
    expect(server.listConnectedPeerClients().length).toBe(1)
  })
})

describe('peer-collab host on/off toggle', () => {
  const clients: PeerClientService[] = []
  const servers: OrcaRuntimeRpcServer[] = []

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.destroy()
    }
    for (const server of servers.splice(0)) {
      await server.stop()
    }
  })

  it('rejects a peer connection with the hosting-disabled close code while hosting is off', async () => {
    const { server, pairingUrl } = await startPeerHost()
    servers.push(server)
    server.setPeerHostingEnabled(false)

    const client = new PeerClientService()
    clients.push(client)
    expect(client.connect(pairingUrl, 'Client A')).toEqual({ ok: true })
    await waitFor(() => client.getStatus().state === 'closed')

    expect(client.getStatus().lastErrorReason).toBe('host_disabled')
    expect(server.listConnectedPeerClients().length).toBe(0)
  })

  it('drops a live peer connection immediately when hosting is switched off', async () => {
    const { server, pairingUrl } = await startPeerHost()
    servers.push(server)

    const client = new PeerClientService()
    clients.push(client)
    expect(client.connect(pairingUrl, 'Client A')).toEqual({ ok: true })
    await waitFor(() => client.getStatus().state === 'connected')

    server.setPeerHostingEnabled(false)
    await waitFor(() => client.getStatus().state === 'closed')

    expect(client.getStatus().lastErrorReason).toBe('host_disabled')
    expect(server.listConnectedPeerClients().length).toBe(0)
  })
})

describe('peer-collab session never touches the cloud relay', () => {
  const clients: PeerClientService[] = []
  const servers: OrcaRuntimeRpcServer[] = []

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.destroy()
    }
    for (const server of servers.splice(0)) {
      await server.stop()
    }
    vi.restoreAllMocks()
  })

  it('never calls relay-http-client across pairing, connect, subscribe, and teardown', async () => {
    const exchangeSpy = vi.spyOn(relayHttpClient, 'exchangeRelayAuthorization')
    const assignmentSpy = vi.spyOn(relayHttpClient, 'requestRelayAssignment')

    const { server, runtime, pairingUrl } = await startPeerHost()
    servers.push(server)
    const client = new PeerClientService()
    clients.push(client)
    expect(client.connect(pairingUrl, 'Client A')).toEqual({ ok: true })
    await waitFor(() => client.getStatus().state === 'connected')

    const events: PeerTerminalStreamEvent[] = []
    const result = client.subscribeTerminal(TEST_TERMINAL, { cols: 80, rows: 24 }, (event) => {
      events.push(event)
    })
    expect(result.ok).toBe(true)
    await waitFor(() => events.some((e) => e.type === 'subscribed'))
    runtime.pushOutput(TEST_TERMINAL, 'x')
    await waitFor(() => events.some((e) => e.type === 'output'))

    client.disconnect()
    await waitFor(() => client.getStatus().state === 'closed')

    expect(exchangeSpy).not.toHaveBeenCalled()
    expect(assignmentSpy).not.toHaveBeenCalled()
  })
})

describe('peer-collab abnormal client termination', () => {
  const servers: OrcaRuntimeRpcServer[] = []
  const rawSockets: WebSocket[] = []

  afterEach(async () => {
    for (const ws of rawSockets.splice(0)) {
      ws.removeAllListeners()
      if (ws.readyState === ws.OPEN) {
        ws.terminate()
      }
    }
    for (const server of servers.splice(0)) {
      await server.stop()
    }
  })

  it("destroying one client's socket without a close handshake leaves the host's fan-out to the other client intact", async () => {
    const { server, runtime, pairingUrl } = await startPeerHost()
    servers.push(server)

    let rawSocketOfA: WebSocket | null = null
    const clientA = new PeerClientService({
      createSocket: (endpoint) => {
        const ws = new WebSocket(endpoint)
        rawSocketOfA = ws
        rawSockets.push(ws)
        return ws
      }
    })
    const clientB = new PeerClientService()
    expect(clientA.connect(pairingUrl, 'Client A')).toEqual({ ok: true })
    await waitFor(() => clientA.getStatus().state === 'connected')
    // Why: mintSecondPeerPairingUrl rotates any still-pending peer device
    // slot, so it must run after clientA's connection has actually consumed
    // the first one (lastSeenAt set) or it discards clientA's own credential.
    expect(clientB.connect(mintSecondPeerPairingUrl(server), 'Client B')).toEqual({ ok: true })
    await waitFor(() => clientB.getStatus().state === 'connected')

    const eventsA: PeerTerminalStreamEvent[] = []
    const eventsB: PeerTerminalStreamEvent[] = []
    const subA = clientA.subscribeTerminal(TEST_TERMINAL, { cols: 80, rows: 24 }, (e) =>
      eventsA.push(e)
    )
    const subB = clientB.subscribeTerminal(TEST_TERMINAL, { cols: 80, rows: 24 }, (e) =>
      eventsB.push(e)
    )
    expect(subA.ok).toBe(true)
    expect(subB.ok).toBe(true)
    await waitFor(() => eventsA.some((e) => e.type === 'subscribed'))
    await waitFor(() => eventsB.some((e) => e.type === 'subscribed'))
    await waitFor(() => server.listConnectedPeerClients().length === 2)

    // Why: a forced destroy (no close frame) is what a killed peer process
    // looks like on the wire — distinct from PeerClientService.disconnect()'s
    // graceful teardown, which the earlier describe block already covers.
    rawSocketOfA!.terminate()

    await waitFor(() => server.listConnectedPeerClients().length === 1)
    await waitFor(() => runtime.activeSubscriptionCount() === 1)

    eventsB.length = 0
    runtime.pushOutput(TEST_TERMINAL, 'host is fine')
    await waitFor(() => eventsB.some((e) => e.type === 'output' && e.data === 'host is fine'))

    clientB.destroy()
  })
})

describe('peer-collab grant enforcement', () => {
  const clients: PeerClientService[] = []
  const servers: OrcaRuntimeRpcServer[] = []

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.destroy()
    }
    for (const server of servers.splice(0)) {
      await server.stop()
    }
  })

  async function connectedUngrantedClient(): Promise<{
    server: OrcaRuntimeRpcServer
    client: PeerClientService
  }> {
    const { server, pairingUrl } = await startPeerHost({ grantedTerminals: [] })
    servers.push(server)
    const client = new PeerClientService()
    clients.push(client)
    expect(client.connect(pairingUrl, 'Client A')).toEqual({ ok: true })
    await waitFor(() => client.getStatus().state === 'connected')
    return { server, client }
  }

  it('rejects terminal.subscribe for a terminal the peer was not granted', async () => {
    const { client } = await connectedUngrantedClient()
    const events: PeerTerminalStreamEvent[] = []
    const result = client.subscribeTerminal(UNGRANTED_TERMINAL, { cols: 80, rows: 24 }, (event) => {
      events.push(event)
    })
    expect(result.ok).toBe(true)
    await waitFor(() => events.some((e) => e.type === 'error'))
    expect(events.some((e) => e.type === 'subscribed')).toBe(false)
  })

  it('rejects terminal.subscribe from a peer that omits client', async () => {
    const { server, pairingUrl } = await startPeerHost({ grantedTerminals: [TEST_TERMINAL] })
    servers.push(server)
    const client = new PeerClientService()
    clients.push(client)
    expect(client.connect(pairingUrl, 'Client A')).toEqual({ ok: true })
    await waitFor(() => client.getStatus().state === 'connected')

    // Why: reach the raw rpc channel to omit `client`, which the real peer client
    // (peer-client-terminal-streams.ts) always fills in — this exercises the
    // server-side guard against a client too old (or malicious) to do the same.
    const rpc = (
      client as unknown as {
        rpc: { sendRequest: (m: string, p: unknown) => Promise<{ ok: boolean }> }
      }
    ).rpc
    const result = await rpc.sendRequest('terminal.subscribe', {
      terminal: TEST_TERMINAL,
      viewport: { cols: 80, rows: 24 }
    })
    expect(result.ok).toBe(false)
  })

  it('rejects terminal.subscribe from a peer that declares a non-desktop client type', async () => {
    const { server, pairingUrl } = await startPeerHost({ grantedTerminals: [TEST_TERMINAL] })
    servers.push(server)
    const client = new PeerClientService()
    clients.push(client)
    expect(client.connect(pairingUrl, 'Client A')).toEqual({ ok: true })
    await waitFor(() => client.getStatus().state === 'connected')

    // Why: client.type is caller-declared; asserting 'mobile' would skip the
    // remote-driver input lock and claim the higher-priority mobile input floor.
    const rpc = (
      client as unknown as {
        rpc: { sendRequest: (m: string, p: unknown) => Promise<{ ok: boolean }> }
      }
    ).rpc
    const result = await rpc.sendRequest('terminal.subscribe', {
      terminal: TEST_TERMINAL,
      client: { id: 'spoofed', type: 'mobile' },
      viewport: { cols: 80, rows: 24 }
    })
    expect(result.ok).toBe(false)
  })

  it('rejects terminal.updateViewport from a peer that does not declare a desktop client type', async () => {
    const { server, pairingUrl } = await startPeerHost({ grantedTerminals: [TEST_TERMINAL] })
    servers.push(server)
    const client = new PeerClientService()
    clients.push(client)
    expect(client.connect(pairingUrl, 'Client A')).toEqual({ ok: true })
    await waitFor(() => client.getStatus().state === 'connected')

    // Why: the handler defaults client.type to 'mobile', so a peer omitting it
    // would reach updateMobileViewport's phone-fit override on the host terminal.
    const rpc = (
      client as unknown as {
        rpc: { sendRequest: (m: string, p: unknown) => Promise<{ ok: boolean }> }
      }
    ).rpc
    const result = await rpc.sendRequest('terminal.updateViewport', {
      terminal: TEST_TERMINAL,
      client: { id: 'spoofed' },
      viewport: { cols: 40, rows: 20 }
    })
    expect(result.ok).toBe(false)
  })

  it('rejects terminal.send for a terminal the peer was not granted', async () => {
    const { client } = await connectedUngrantedClient()
    // Why: PeerClientService only exposes input via an established subscribe
    // stream (sendTerminalInput); the one-shot terminal.send RPC has no public
    // wrapper, so reach the shared rpc channel directly to exercise its guard.
    const rpc = (
      client as unknown as {
        rpc: { sendRequest: (m: string, p: unknown) => Promise<{ ok: boolean }> }
      }
    ).rpc
    const result = await rpc.sendRequest('terminal.send', {
      terminal: UNGRANTED_TERMINAL,
      text: 'ls\n'
    })
    expect(result.ok).toBe(false)
  })

  it('never returns the handle or title of an ungranted terminal from terminal.list', async () => {
    const { server, pairingUrl } = await startPeerHost({ grantedTerminals: [TEST_TERMINAL] })
    servers.push(server)
    const client = new PeerClientService()
    clients.push(client)
    expect(client.connect(pairingUrl, 'Client A')).toEqual({ ok: true })
    await waitFor(() => client.getStatus().state === 'connected')

    const result = (await client.listHostTerminals()) as {
      terminals: { handle: string; title: string | null }[]
      visualLayouts?: unknown
    }
    expect(result.terminals.map((t) => t.handle)).toEqual([TEST_TERMINAL])
    expect(JSON.stringify(result)).not.toContain('secret title')
    expect(JSON.stringify(result)).not.toContain(UNGRANTED_TERMINAL)
  })

  it('sends the tab-resolved title, not the raw live title, from terminal.list', async () => {
    const { server, pairingUrl } = await startPeerHost({ grantedTerminals: [TEST_TERMINAL] })
    servers.push(server)
    const client = new PeerClientService()
    clients.push(client)
    expect(client.connect(pairingUrl, 'Client A')).toEqual({ ok: true })
    await waitFor(() => client.getStatus().state === 'connected')

    const result = (await client.listHostTerminals()) as {
      terminals: { handle: string; title: string | null }[]
    }
    expect(result.terminals).toEqual([
      expect.objectContaining({ handle: TEST_TERMINAL, title: 'resolved tab title' })
    ])
  })
})

describe('peer-collab grant revocation mid-stream', () => {
  const clients: PeerClientService[] = []
  const servers: OrcaRuntimeRpcServer[] = []

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.destroy()
    }
    for (const server of servers.splice(0)) {
      await server.stop()
    }
  })

  it("(a) ends the revoked client's stream and stops further output once the grant is pulled", async () => {
    const { server, runtime, pairingUrl, deviceId } = await startPeerHost()
    servers.push(server)

    const clientA = await connectedClient(clients, pairingUrl, 'Client A')
    const eventsA: PeerTerminalStreamEvent[] = []
    subscribeAndAwait(clientA, eventsA)
    await waitFor(() => eventsA.some((e) => e.type === 'subscribed'))
    await waitFor(() => runtime.activeSubscriptionCount() === 1)

    server.setGrantedTerminals(deviceId, [])

    await waitFor(() => eventsA.some((e) => e.type === 'error'))
    await waitFor(() => eventsA.some((e) => e.type === 'end'))
    await waitFor(() => runtime.activeSubscriptionCount() === 0)

    eventsA.length = 0
    runtime.pushOutput(TEST_TERMINAL, 'should never arrive')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(eventsA).toEqual([])
  })

  it('(b) drops an input frame the moment the grant is gone, even before subscription teardown runs', async () => {
    const { server, runtime, pairingUrl, deviceId } = await startPeerHost()
    servers.push(server)

    const clientA = await connectedClient(clients, pairingUrl, 'Client A')
    const eventsA: PeerTerminalStreamEvent[] = []
    const { requestId } = subscribeAndAwait(clientA, eventsA)
    await waitFor(() => eventsA.some((e) => e.type === 'subscribed'))

    // Why: mutate the grant store directly (bypassing RuntimeRpc.setGrantedTerminals'
    // own teardown) so this isolates the per-frame re-check from the subscription
    // cleanup covered by test (a) — the guard alone must still block input.
    server.getDeviceRegistry()?.setGrantedTerminals(deviceId, [])

    expect(clientA.sendTerminalInput(requestId, 'should-be-dropped\n')).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(runtime.inputLog).toEqual([])
  })

  it("(c) leaves another still-granted client's stream and input untouched", async () => {
    const { server, runtime, pairingUrl, deviceId } = await startPeerHost()
    servers.push(server)

    const clientA = await connectedClient(clients, pairingUrl, 'Client A')
    const clientB = await connectedClient(clients, mintSecondPeerPairingUrl(server), 'Client B')
    const eventsA: PeerTerminalStreamEvent[] = []
    const eventsB: PeerTerminalStreamEvent[] = []
    subscribeAndAwait(clientA, eventsA)
    const { requestId: requestIdB } = subscribeAndAwait(clientB, eventsB)
    await waitFor(() => eventsA.some((e) => e.type === 'subscribed'))
    await waitFor(() => eventsB.some((e) => e.type === 'subscribed'))
    await waitFor(() => runtime.activeSubscriptionCount() === 2)

    server.setGrantedTerminals(deviceId, [])

    await waitFor(() => eventsA.some((e) => e.type === 'end'))
    await waitFor(() => runtime.activeSubscriptionCount() === 1)

    eventsB.length = 0
    runtime.pushOutput(TEST_TERMINAL, 'still for B')
    await waitFor(() => eventsB.some((e) => e.type === 'output' && e.data === 'still for B'))

    expect(clientB.sendTerminalInput(requestIdB, 'b-still-works\n')).toBe(true)
    await waitFor(() => runtime.inputLog.some((entry) => entry.text === 'b-still-works\n'))
  })

  it('(d) is a peer-only mechanism — a non-peer connection is never subject to the grant check', () => {
    // Why: the WS harness has no mobile-scope fixture, and mobile subscriptionIds
    // never share a peer connectionId, so this exercises the actual gate
    // (ctx.isPeerDevice) that keeps mobile/local streams structurally outside
    // terminatePeerTerminalStreams' reach — it only ever iterates a peer
    // deviceId's own connectionId.
    expect(
      isPeerTerminalGranted({ isPeerDevice: false, getGrantedTerminals: () => [] }, TEST_TERMINAL)
    ).toBe(true)
  })

  it('cleans up a presence subscription for the same terminal alongside the terminal stream', async () => {
    const { server, runtime, pairingUrl, deviceId } = await startPeerHost()
    servers.push(server)

    const clientA = await connectedClient(clients, pairingUrl, 'Client A')
    const eventsA: PeerTerminalStreamEvent[] = []
    subscribeAndAwait(clientA, eventsA)
    await waitFor(() => eventsA.some((e) => e.type === 'subscribed'))
    await waitFor(() => server.listConnectedPeerClients().length === 1)

    const connectionId = server.listConnectedPeerClients()[0]?.connectionId
    if (!connectionId) {
      throw new Error('expected a connected peer client')
    }
    let presenceCleanedUp = false
    runtime.runtime.registerSubscriptionCleanup(
      `terminal-presence:${TEST_TERMINAL}:${connectionId}-1`,
      () => {
        presenceCleanedUp = true
      },
      connectionId
    )
    await waitFor(() => runtime.activeSubscriptionCount() === 2)

    server.setGrantedTerminals(deviceId, [])

    await waitFor(() => runtime.activeSubscriptionCount() === 0)
    expect(presenceCleanedUp).toBe(true)
  })
})
