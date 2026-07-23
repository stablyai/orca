import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { parsePairingCode } from '../../shared/pairing'
import type { RuntimeMobileSessionTabsResult } from '../../shared/runtime-types'
import type { PersistedMobileClientTabSelections } from '../../shared/types'
import { OrcaRuntimeService } from './orca-runtime'
import { decrypt, deriveSharedKey, encrypt, generateKeyPair } from './rpc/e2ee-crypto'
import { OrcaRuntimeRpcServer } from './runtime-rpc'

const REPO_ID = 'repo-1'
const worktreeId = (name: string): string => `${REPO_ID}::/tmp/${name}`
const HOST_WORKTREE_ID = worktreeId('host')
const CLIENT_A_WORKTREE_ID = worktreeId('client-a')
const CLIENT_A2_WORKTREE_ID = worktreeId('client-a2')
const CLIENT_B_WORKTREE_ID = worktreeId('client-b')
const SESSION_WORKTREE_ID = worktreeId('session')

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue(
    ['host', 'client-a', 'client-a2', 'client-b', 'session'].map((name) => ({
      path: `/tmp/${name}`,
      head: name,
      branch: name,
      isBare: false,
      isMainWorktree: false
    }))
  ),
  listWorktreesStrict: vi.fn().mockResolvedValue([])
}))

type PairedSession = {
  ws: WebSocket
  sharedKey: Uint8Array
}

type ResponseReader = {
  next: (
    id: string,
    predicate?: (response: Record<string, unknown>) => boolean
  ) => Promise<Record<string, unknown>>
  dispose: () => void
}

function makeStore() {
  const worktreeMeta = Object.fromEntries(
    [
      HOST_WORKTREE_ID,
      CLIENT_A_WORKTREE_ID,
      CLIENT_A2_WORKTREE_ID,
      CLIENT_B_WORKTREE_ID,
      SESSION_WORKTREE_ID
    ].map((id) => [
      id,
      {
        displayName: id.split('/').at(-1) ?? id,
        comment: '',
        linkedIssue: null,
        linkedPR: null,
        linkedLinearIssue: null,
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: 0,
        instanceId: id
      }
    ])
  )
  return {
    getRepo: (id: string) => (id === REPO_ID ? makeStore().getRepos()[0] : undefined),
    getRepos: () => [
      {
        id: REPO_ID,
        path: '/tmp/repo',
        displayName: 'repo',
        badgeColor: 'blue',
        addedAt: 1
      }
    ],
    addRepo: () => {},
    updateRepo: () => undefined as never,
    getAllWorktreeMeta: () => worktreeMeta,
    getWorktreeMeta: (id: string) => worktreeMeta[id],
    setWorktreeMeta: () => undefined as never,
    removeWorktreeMeta: () => {},
    getSettings: () => ({
      workspaceDir: '/tmp/workspaces',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      branchPrefix: 'none',
      branchPrefixCustom: ''
    })
  }
}

function connect(endpoint: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(endpoint)
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

function nextMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve(typeof data === 'string' ? data : data.toString('utf-8')))
  })
}

async function authenticate(pairingUrl: string): Promise<PairedSession> {
  const pairing = parsePairingCode(pairingUrl)
  if (!pairing) {
    throw new Error('invalid_pairing_url')
  }
  const ws = await connect(pairing.endpoint)
  const keys = generateKeyPair()
  const serverPublicKey = Uint8Array.from(Buffer.from(pairing.publicKeyB64, 'base64'))
  const sharedKey = deriveSharedKey(keys.secretKey, serverPublicKey)
  ws.send(
    JSON.stringify({
      type: 'e2ee_hello',
      publicKeyB64: Buffer.from(keys.publicKey).toString('base64')
    })
  )
  expect(JSON.parse(await nextMessage(ws))).toEqual({ type: 'e2ee_ready' })
  ws.send(
    encrypt(JSON.stringify({ type: 'e2ee_auth', deviceToken: pairing.deviceToken }), sharedKey)
  )
  expect(JSON.parse(decrypt(await nextMessage(ws), sharedKey)!)).toEqual({
    type: 'e2ee_authenticated'
  })
  return { ws, sharedKey }
}

function send(session: PairedSession, request: Record<string, unknown>): void {
  session.ws.send(encrypt(JSON.stringify(request), session.sharedKey))
}

function createReader(session: PairedSession): ResponseReader {
  type Waiter = {
    id: string
    predicate: (response: Record<string, unknown>) => boolean
    resolve: (response: Record<string, unknown>) => void
  }
  const queued: Record<string, unknown>[] = []
  const waiters: Waiter[] = []
  const onMessage = (data: WebSocket.RawData): void => {
    const plaintext = decrypt(
      typeof data === 'string' ? data : data.toString('utf-8'),
      session.sharedKey
    )
    if (!plaintext) {
      return
    }
    const response = JSON.parse(plaintext) as Record<string, unknown>
    const waiterIndex = waiters.findIndex(
      (waiter) => response.id === waiter.id && waiter.predicate(response)
    )
    if (waiterIndex === -1) {
      queued.push(response)
      return
    }
    waiters.splice(waiterIndex, 1)[0]?.resolve(response)
  }
  session.ws.on('message', onMessage)
  return {
    next: (id, predicate = () => true) => {
      const queuedIndex = queued.findIndex((response) => response.id === id && predicate(response))
      if (queuedIndex !== -1) {
        return Promise.resolve(queued.splice(queuedIndex, 1)[0]!)
      }
      return new Promise((resolve) => waiters.push({ id, predicate, resolve }))
    },
    dispose: () => {
      session.ws.off('message', onMessage)
      queued.length = 0
      waiters.length = 0
    }
  }
}

function resultType(response: Record<string, unknown>): string | undefined {
  return (response.result as { type?: string } | undefined)?.type
}

function activeTabId(response: Record<string, unknown>): string | null {
  return (response.result as RuntimeMobileSessionTabsResult | undefined)?.activeTabId ?? null
}

function snapshotVersion(response: Record<string, unknown>): number {
  return (response.result as RuntimeMobileSessionTabsResult | undefined)?.snapshotVersion ?? -1
}

function seedSessionTabs(runtime: OrcaRuntimeService): void {
  const tabs = ['host-tab', 'client-a-tab', 'client-a2-tab', 'client-b-tab'].map((id, index) => ({
    type: 'terminal' as const,
    id,
    parentTabId: id,
    leafId: `pane:${index + 1}`,
    ptyId: `pty-${index + 1}`,
    title: id,
    isActive: id === 'host-tab'
  }))
  runtime.syncWindowGraph(1, {
    tabs: [],
    leaves: [],
    mobileSessionTabs: [
      {
        worktree: SESSION_WORKTREE_ID,
        publicationEpoch: 'renderer:host',
        snapshotVersion: 1,
        activeGroupId: 'group-1',
        activeTabId: 'host-tab',
        activeTabType: 'terminal',
        tabGroups: [
          {
            id: 'group-1',
            activeTabId: 'host-tab',
            tabOrder: tabs.map((tab) => tab.parentTabId)
          }
        ],
        tabs
      }
    ]
  })
  for (let index = 0; index < tabs.length; index += 1) {
    runtime.registerPty(`pty-${index + 1}`, SESSION_WORKTREE_ID)
  }
}

describe('paired runtime navigation isolation', () => {
  const servers: OrcaRuntimeRpcServer[] = []
  const sessions: PairedSession[] = []
  const readers: ResponseReader[] = []

  afterEach(async () => {
    for (const reader of readers.splice(0)) {
      reader.dispose()
    }
    for (const session of sessions.splice(0)) {
      session.ws.close()
    }
    await Promise.all(servers.splice(0).map((server) => server.stop()))
  })

  async function startHarness() {
    const hostSelections = { worktreeId: HOST_WORKTREE_ID, tabId: 'host-tab' }
    const activateWorktree = vi.fn((_repoId: string, nextWorktreeId: string) => {
      hostSelections.worktreeId = nextWorktreeId
    })
    const focusTerminal = vi.fn((nextTabId: string) => {
      hostSelections.tabId = nextTabId
    })
    const runtime = new OrcaRuntimeService(makeStore() as never)
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree,
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal,
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)
    runtime.markGraphReady(1)
    seedSessionTabs(runtime)

    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath: mkdtempSync(join(tmpdir(), 'orca-navigation-isolation-')),
      enableWebSocket: true,
      wsPort: 0
    })
    servers.push(server)
    await server.start()

    const offerA = server.createPairingOffer({
      address: '127.0.0.1',
      name: 'client-a',
      scope: 'runtime'
    })
    if (!offerA.available) {
      throw new Error('pairing_unavailable')
    }
    const clientA = await authenticate(offerA.pairingUrl)
    sessions.push(clientA)
    const offerB = server.createPairingOffer({
      address: '127.0.0.1',
      name: 'client-b',
      scope: 'runtime'
    })
    if (!offerB.available) {
      throw new Error('pairing_unavailable')
    }
    const clientB = await authenticate(offerB.pairingUrl)
    sessions.push(clientB)
    expect(offerA.deviceId).not.toBe(offerB.deviceId)
    expect(parsePairingCode(offerA.pairingUrl)?.deviceToken).not.toBe(
      parsePairingCode(offerB.pairingUrl)?.deviceToken
    )

    const readerA = createReader(clientA)
    const readerB = createReader(clientB)
    readers.push(readerA, readerB)
    return {
      runtime,
      hostSelections,
      activateWorktree,
      focusTerminal,
      clientA,
      clientB,
      pairingUrlA: offerA.pairingUrl,
      readerA,
      readerB
    }
  }

  it('keeps worktree navigation local to each paired runtime client by default', async () => {
    const harness = await startHarness()
    const clientSelections = {
      a: CLIENT_A_WORKTREE_ID,
      b: CLIENT_B_WORKTREE_ID
    }
    for (const [session, id] of [
      [harness.clientA, 'events-a'],
      [harness.clientB, 'events-b']
    ] as const) {
      send(session, { id, method: 'runtime.clientEvents.subscribe' })
    }
    await Promise.all([
      harness.readerA.next('events-a', (response) => resultType(response) === 'ready'),
      harness.readerB.next('events-b', (response) => resultType(response) === 'ready')
    ])

    clientSelections.a = CLIENT_A2_WORKTREE_ID
    send(harness.clientA, {
      id: 'activate-a2',
      method: 'worktree.activate',
      params: {
        worktree: `id:${CLIENT_A2_WORKTREE_ID}`,
        notifyClients: true
      }
    })
    await expect(harness.readerA.next('activate-a2')).resolves.toMatchObject({ ok: true })

    harness.runtime.notifyWorktreesChangedForRemoteClients(REPO_ID)
    const [nextA, nextB] = await Promise.all([
      harness.readerA.next('events-a'),
      harness.readerB.next('events-b')
    ])
    expect([resultType(nextA), resultType(nextB)]).toEqual(['worktreesChanged', 'worktreesChanged'])
    expect(clientSelections).toEqual({
      a: CLIENT_A2_WORKTREE_ID,
      b: CLIENT_B_WORKTREE_ID
    })
    expect(harness.hostSelections.worktreeId).toBe(HOST_WORKTREE_ID)
    expect(harness.activateWorktree).not.toHaveBeenCalled()
  })

  it('projects session-tab activation only to the paired caller across fanout and reconnect', async () => {
    const harness = await startHarness()

    send(harness.clientA, {
      id: 'select-a',
      method: 'session.tabs.activate',
      params: {
        worktree: `id:${SESSION_WORKTREE_ID}`,
        tabId: 'client-a-tab',
        navigation: 'caller',
        notifyClients: false
      }
    })
    send(harness.clientB, {
      id: 'select-b',
      method: 'session.tabs.activate',
      params: {
        worktree: `id:${SESSION_WORKTREE_ID}`,
        tabId: 'client-b-tab',
        navigation: 'caller',
        notifyClients: false
      }
    })
    expect(activeTabId(await harness.readerA.next('select-a'))).toBe('client-a-tab')
    expect(activeTabId(await harness.readerB.next('select-b'))).toBe('client-b-tab')

    for (const [session, id] of [
      [harness.clientA, 'tabs-a'],
      [harness.clientB, 'tabs-b']
    ] as const) {
      send(session, {
        id,
        method: 'session.tabs.subscribe',
        params: { worktree: `id:${SESSION_WORKTREE_ID}` }
      })
    }
    expect(activeTabId(await harness.readerA.next('tabs-a'))).toBe('client-a-tab')
    expect(activeTabId(await harness.readerB.next('tabs-b'))).toBe('client-b-tab')

    send(harness.clientA, {
      id: 'select-a2',
      method: 'session.tabs.activate',
      params: {
        worktree: `id:${SESSION_WORKTREE_ID}`,
        tabId: 'client-a2-tab',
        navigation: 'caller',
        notifyClients: false
      }
    })
    const selectA2 = await harness.readerA.next('select-a2')
    expect(activeTabId(selectA2)).toBe('client-a2-tab')

    harness.runtime.notifyMobileSessionTabsChanged(SESSION_WORKTREE_ID)
    const [updateA, updateB] = await Promise.all([
      harness.readerA.next(
        'tabs-a',
        (response) =>
          resultType(response) === 'updated' &&
          snapshotVersion(response) >= snapshotVersion(selectA2)
      ),
      harness.readerB.next('tabs-b', (response) => resultType(response) === 'updated')
    ])
    expect(activeTabId(updateA)).toBe('client-a2-tab')
    expect(activeTabId(updateB)).toBe('client-b-tab')
    expect(harness.hostSelections.tabId).toBe('host-tab')
    expect(harness.focusTerminal).not.toHaveBeenCalled()
    expect(
      (await harness.runtime.listMobileSessionTabs(`id:${SESSION_WORKTREE_ID}`)).activeTabId
    ).toBe('host-tab')

    harness.readerA.dispose()
    harness.clientA.ws.close()
    const reconnectedA = await authenticate(harness.pairingUrlA)
    sessions.push(reconnectedA)
    const reconnectedReaderA = createReader(reconnectedA)
    readers.push(reconnectedReaderA)
    send(reconnectedA, {
      id: 'tabs-a-reconnected',
      method: 'session.tabs.list',
      params: { worktree: `id:${SESSION_WORKTREE_ID}` }
    })
    expect(activeTabId(await reconnectedReaderA.next('tabs-a-reconnected'))).toBe('client-a2-tab')
  })

  it('routes explicit host and paired-client follow intent without changing the default', async () => {
    const harness = await startHarness()
    for (const [session, id] of [
      [harness.clientA, 'events-a'],
      [harness.clientB, 'events-b']
    ] as const) {
      send(session, { id, method: 'runtime.clientEvents.subscribe' })
    }
    await Promise.all([
      harness.readerA.next('events-a', (response) => resultType(response) === 'ready'),
      harness.readerB.next('events-b', (response) => resultType(response) === 'ready')
    ])

    send(harness.clientA, {
      id: 'host-follow',
      method: 'worktree.activate',
      params: { worktree: `id:${CLIENT_A_WORKTREE_ID}`, navigation: 'host' }
    })
    await harness.readerA.next('host-follow')
    harness.runtime.notifyWorktreesChangedForRemoteClients(REPO_ID)
    expect(resultType(await harness.readerA.next('events-a'))).toBe('worktreesChanged')
    expect(resultType(await harness.readerB.next('events-b'))).toBe('worktreesChanged')
    expect(harness.hostSelections.worktreeId).toBe(CLIENT_A_WORKTREE_ID)

    send(harness.clientB, {
      id: 'clients-follow',
      method: 'worktree.activate',
      params: { worktree: `id:${CLIENT_B_WORKTREE_ID}`, navigation: 'clients' }
    })
    await harness.readerB.next('clients-follow')
    const [eventA, eventB] = await Promise.all([
      harness.readerA.next('events-a'),
      harness.readerB.next('events-b')
    ])
    expect([resultType(eventA), resultType(eventB)]).toEqual([
      'activateWorktree',
      'activateWorktree'
    ])
    expect(harness.hostSelections.worktreeId).toBe(CLIENT_A_WORKTREE_ID)

    for (const [session, id] of [
      [harness.clientA, 'tabs-a'],
      [harness.clientB, 'tabs-b']
    ] as const) {
      send(session, {
        id,
        method: 'session.tabs.subscribe',
        params: { worktree: `id:${SESSION_WORKTREE_ID}` }
      })
    }
    await Promise.all([harness.readerA.next('tabs-a'), harness.readerB.next('tabs-b')])
    send(harness.clientA, {
      id: 'tabs-host-follow',
      method: 'session.tabs.activate',
      params: {
        worktree: `id:${SESSION_WORKTREE_ID}`,
        tabId: 'client-a-tab',
        navigation: 'host'
      }
    })
    expect(activeTabId(await harness.readerA.next('tabs-host-follow'))).toBe('client-a-tab')
    expect(
      activeTabId(
        await harness.readerA.next('tabs-a', (response) => resultType(response) === 'updated')
      )
    ).toBe('client-a-tab')
    expect(harness.hostSelections.tabId).toBe('client-a-tab')

    send(harness.clientB, {
      id: 'tabs-clients-follow',
      method: 'session.tabs.activate',
      params: {
        worktree: `id:${SESSION_WORKTREE_ID}`,
        tabId: 'client-b-tab',
        navigation: 'clients'
      }
    })
    await harness.readerB.next('tabs-clients-follow')
    const [tabsA, tabsB] = await Promise.all([
      harness.readerA.next('tabs-a', (response) => resultType(response) === 'updated'),
      harness.readerB.next('tabs-b', (response) => resultType(response) === 'updated')
    ])
    expect([activeTabId(tabsA), activeTabId(tabsB)]).toEqual(['client-b-tab', 'client-b-tab'])
    expect(
      [tabsA, tabsB].map(
        (response) =>
          (response.result as RuntimeMobileSessionTabsResult | undefined)?.navigationIntent
      )
    ).toEqual(['follow', 'follow'])
    expect(harness.hostSelections.tabId).toBe('client-a-tab')
  })

  it('isolates crossed clients across two runtime servers', async () => {
    const serverOne = await startHarness()
    const serverTwo = await startHarness()
    for (const [session, id] of [
      [serverTwo.clientA, 'server-two-events-a'],
      [serverTwo.clientB, 'server-two-events-b']
    ] as const) {
      send(session, { id, method: 'runtime.clientEvents.subscribe' })
    }
    await Promise.all([
      serverTwo.readerA.next('server-two-events-a', (response) => resultType(response) === 'ready'),
      serverTwo.readerB.next('server-two-events-b', (response) => resultType(response) === 'ready')
    ])

    send(serverOne.clientA, {
      id: 'server-one-worktree',
      method: 'worktree.activate',
      params: { worktree: `id:${CLIENT_A2_WORKTREE_ID}`, notifyClients: true }
    })
    await serverOne.readerA.next('server-one-worktree')
    serverTwo.runtime.notifyWorktreesChangedForRemoteClients(REPO_ID)
    expect(resultType(await serverTwo.readerA.next('server-two-events-a'))).toBe('worktreesChanged')
    expect(resultType(await serverTwo.readerB.next('server-two-events-b'))).toBe('worktreesChanged')
    expect(serverOne.hostSelections.worktreeId).toBe(HOST_WORKTREE_ID)
    expect(serverTwo.hostSelections.worktreeId).toBe(HOST_WORKTREE_ID)

    for (const [session, reader, requestId, tabId] of [
      [serverOne.clientA, serverOne.readerA, 's1-a', 'client-a2-tab'],
      [serverOne.clientB, serverOne.readerB, 's1-b', 'client-b-tab'],
      [serverTwo.clientA, serverTwo.readerA, 's2-a', 'client-a-tab'],
      [serverTwo.clientB, serverTwo.readerB, 's2-b', 'host-tab']
    ] as const) {
      send(session, {
        id: requestId,
        method: 'session.tabs.activate',
        params: {
          worktree: `id:${SESSION_WORKTREE_ID}`,
          tabId,
          navigation: 'caller',
          notifyClients: false
        }
      })
      expect(activeTabId(await reader.next(requestId))).toBe(tabId)
    }

    expect(serverOne.hostSelections.tabId).toBe('host-tab')
    expect(serverTwo.hostSelections.tabId).toBe('host-tab')
  })

  it('restores a device tab selection after a runtime restart', async () => {
    const persisted: { state: PersistedMobileClientTabSelections } = { state: {} }
    const makeStoreWithSelections = () => ({
      ...makeStore(),
      getMobileClientTabSelections: () => persisted.state,
      setMobileClientTabSelections: (next: PersistedMobileClientTabSelections) => {
        persisted.state = next
      }
    })

    const first = new OrcaRuntimeService(makeStoreWithSelections() as never)
    first.attachWindow(1)
    first.markGraphReady(1)
    seedSessionTabs(first)
    await first.activateMobileSessionTab(`id:${SESSION_WORKTREE_ID}`, 'client-a-tab', undefined, {
      notifyClients: false,
      clientNavigationId: 'device-a',
      navigation: 'caller'
    })
    expect(persisted.state['device-a']?.[SESSION_WORKTREE_ID]?.activeTabId).toBe('client-a-tab')

    const restarted = new OrcaRuntimeService(makeStoreWithSelections() as never)
    restarted.attachWindow(1)
    restarted.markGraphReady(1)
    seedSessionTabs(restarted)
    const remembered = await restarted.listMobileSessionTabs(
      `id:${SESSION_WORKTREE_ID}`,
      'device-a'
    )
    expect(remembered.activeTabId).toBe('client-a-tab')
    expect(remembered.tabs.find((tab) => tab.isActive)?.id).toBe('client-a-tab')
    // Why: an unknown device must still start from deterministic topology, not inherit another device's restored state.
    const freshDevice = await restarted.listMobileSessionTabs(
      `id:${SESSION_WORKTREE_ID}`,
      'device-b'
    )
    expect(freshDevice.activeTabId).toBe('host-tab')
  })
})
