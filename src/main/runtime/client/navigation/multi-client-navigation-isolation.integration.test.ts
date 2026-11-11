import type * as WorktreeScanCacheModule from '../../../git/worktrees/catalog/worktree-scan-cache'
import type * as WorktreeListingModule from '../../../git/worktrees/catalog/worktree-listing'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { parsePairingCode } from '../../../../shared/remote-runtime/pairing/pairing'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-session-contracts'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrcaRuntimeRpcServer } from '../../rpc/server/runtime-rpc'
import {
  activeTabId,
  authenticate,
  CLIENT_A2_WORKTREE_ID,
  CLIENT_A_WORKTREE_ID,
  CLIENT_B_WORKTREE_ID,
  createReader,
  FOLDER_REPO_ID,
  HOST_WORKTREE_ID,
  makeStore,
  REPO_ID,
  resultType,
  seedSessionTabs,
  send,
  SESSION_WORKTREE_ID,
  snapshotVersion,
  type PairedSession,
  type ResponseReader
} from './paired-client-navigation-test-harness'

vi.mock('../../../git/worktrees/catalog/worktree-scan-cache', async (importOriginal) => {
  const listings = getWorktreeListingMocks()
  return {
    ...(await importOriginal<typeof WorktreeScanCacheModule>()),
    listWorktrees: listings.listWorktrees
  }
})

vi.mock('../../../git/worktrees/catalog/worktree-listing', async (importOriginal) => {
  const listings = getWorktreeListingMocks()
  return {
    ...(await importOriginal<typeof WorktreeListingModule>()),
    listWorktreesStrict: listings.listWorktreesStrict
  }
})

const { getWorktreeListingMocks } = vi.hoisted(() => {
  function createWorktreeListingMocks() {
    const worktrees = ['host', 'client-a', 'client-a2', 'client-b', 'session'].map((name) => ({
      path: `/tmp/${name}`,
      head: name,
      branch: name,
      isBare: false,
      isMainWorktree: false
    }))
    return {
      listWorktrees: vi.fn().mockResolvedValue(worktrees),
      listWorktreesStrict: vi.fn().mockResolvedValue(worktrees)
    }
  }
  let listings: ReturnType<typeof createWorktreeListingMocks> | undefined
  return { getWorktreeListingMocks: () => (listings ??= createWorktreeListingMocks()) }
})

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

  async function startHarness(options: { headless?: boolean } = {}) {
    const hostSelections = { worktreeId: HOST_WORKTREE_ID, tabId: 'host-tab' }
    const activateWorktree = vi.fn((_repoId: string, nextWorktreeId: string) => {
      hostSelections.worktreeId = nextWorktreeId
    })
    const focusTerminal = vi.fn((nextTabId: string) => {
      hostSelections.tabId = nextTabId
    })
    const runtime = new OrcaRuntimeService(makeStore() as never)
    if (!options.headless) {
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
        terminalFitOverrideChanged: vi.fn(),
        terminalDriverChanged: vi.fn()
      })
      runtime.attachWindow(1)
      runtime.markGraphReady(1)
      seedSessionTabs(runtime)
    }

    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-navigation-isolation-'))
    onTestFinished(() => rmSync(userDataPath, { recursive: true, force: true }))

    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
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
    expect(parsePairingCode(offerA.pairingUrl)?.pairedDeviceId).toBe(offerA.deviceId)
    expect(parsePairingCode(offerB.pairingUrl)?.pairedDeviceId).toBe(offerB.deviceId)
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
      deviceIdA: offerA.deviceId,
      deviceIdB: offerB.deviceId,
      pairingUrlA: offerA.pairingUrl,
      pairingUrlB: offerB.pairingUrl,
      readerA,
      readerB
    }
  }

  async function subscribeBothClientEventStreams(harness: {
    clientA: PairedSession
    clientB: PairedSession
    readerA: ResponseReader
    readerB: ResponseReader
  }): Promise<void> {
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
  }

  it('keeps a paired client workspace create-with-activate off every other client and the host', async () => {
    const harness = await startHarness()
    await subscribeBothClientEventStreams(harness)

    for (const [index, target] of [
      CLIENT_A2_WORKTREE_ID,
      CLIENT_A_WORKTREE_ID,
      CLIENT_A2_WORKTREE_ID
    ].entries()) {
      send(harness.clientA, {
        id: `nav-${index}`,
        method: 'worktree.activate',
        params: { worktree: `id:${target}` }
      })
      await expect(harness.readerA.next(`nav-${index}`)).resolves.toMatchObject({ ok: true })
    }

    send(harness.clientA, {
      id: 'create-with-agent',
      method: 'worktree.create',
      params: {
        repo: FOLDER_REPO_ID,
        name: 'teammate-agent-workspace',
        activate: true
      }
    })
    await expect(harness.readerA.next('create-with-agent')).resolves.toMatchObject({ ok: true })

    // Ordered shared-catalog event fences the assertion: any erroneous activation would arrive before it.
    harness.runtime.notifyReposChangedForRemoteClients()
    const observed: Record<'a' | 'b', string[]> = { a: [], b: [] }
    for (const [key, reader, id] of [
      ['a', harness.readerA, 'events-a'],
      ['b', harness.readerB, 'events-b']
    ] as const) {
      for (;;) {
        const type = resultType(await reader.next(id))
        observed[key].push(type ?? 'unknown')
        if (type === 'reposChanged' || type === 'activateWorktree') {
          break
        }
      }
    }

    expect(observed.b).not.toContain('activateWorktree')
    expect(observed.b.at(-1)).toBe('reposChanged')
    expect(harness.activateWorktree).not.toHaveBeenCalled()
    expect(harness.hostSelections.worktreeId).toBe(HOST_WORKTREE_ID)
    expect(observed.a).not.toContain('activateWorktree')
    expect(observed.a.at(-1)).toBe('reposChanged')
    expect(observed.a).toContain('worktreesChanged')
    expect(observed.b).toContain('worktreesChanged')
  })

  it('does not replay a missed create activation to a reconnecting observer', async () => {
    const harness = await startHarness()
    await subscribeBothClientEventStreams(harness)

    harness.readerB.dispose()
    await new Promise<void>((resolve) => {
      harness.clientB.ws.once('close', () => resolve())
      harness.clientB.ws.close()
    })

    // navigation: all proves an activation occurred while B was offline; caller-scoped creates emit none.
    send(harness.clientA, {
      id: 'create-while-b-offline',
      method: 'worktree.create',
      params: {
        repo: FOLDER_REPO_ID,
        name: 'offline-observer-workspace',
        activate: true,
        navigation: 'all'
      }
    })
    await expect(harness.readerA.next('create-while-b-offline')).resolves.toMatchObject({
      ok: true
    })
    expect(
      resultType(
        await harness.readerA.next(
          'events-a',
          (response) => resultType(response) === 'activateWorktree'
        )
      )
    ).toBe('activateWorktree')

    const reconnectedB = await authenticate(harness.pairingUrlB)
    sessions.push(reconnectedB)
    const reconnectedReaderB = createReader(reconnectedB)
    readers.push(reconnectedReaderB)
    send(reconnectedB, { id: 'events-b2', method: 'runtime.clientEvents.subscribe' })
    await reconnectedReaderB.next('events-b2', (response) => resultType(response) === 'ready')

    // Ready snapshots must never retain live navigation intent and replay it on reconnect.
    harness.runtime.notifyReposChangedForRemoteClients()
    const observed: string[] = []
    for (;;) {
      const type = resultType(await reconnectedReaderB.next('events-b2'))
      observed.push(type ?? 'unknown')
      if (type === 'reposChanged' || type === 'activateWorktree') {
        break
      }
    }
    expect(observed).not.toContain('activateWorktree')
    expect(observed.at(-1)).toBe('reposChanged')
  })

  it('still reveals to every client when a paired caller asks for all-surface navigation', async () => {
    const harness = await startHarness()
    await subscribeBothClientEventStreams(harness)

    send(harness.clientA, {
      id: 'cli-shaped-create',
      method: 'worktree.create',
      params: {
        repo: FOLDER_REPO_ID,
        name: 'cli-shaped-workspace',
        activate: true,
        navigation: 'all'
      }
    })
    await expect(harness.readerA.next('cli-shaped-create')).resolves.toMatchObject({ ok: true })

    const [eventA, eventB] = await Promise.all([
      harness.readerA.next('events-a', (response) => resultType(response) === 'activateWorktree'),
      harness.readerB.next('events-b', (response) => resultType(response) === 'activateWorktree')
    ])
    expect([resultType(eventA), resultType(eventB)]).toEqual([
      'activateWorktree',
      'activateWorktree'
    ])
    expect(harness.activateWorktree).toHaveBeenCalled()
    expect(eventA).toMatchObject({ result: { navigation: 'all' } })
    expect(eventB).toMatchObject({ result: { navigation: 'all' } })
  })

  it('keeps create activation caller-scoped on a headless orca serve host', async () => {
    const harness = await startHarness({ headless: true })
    await subscribeBothClientEventStreams(harness)

    send(harness.clientA, {
      id: 'headless-create',
      method: 'worktree.create',
      params: { repo: FOLDER_REPO_ID, name: 'headless-agent-workspace', activate: true }
    })
    await expect(harness.readerA.next('headless-create')).resolves.toMatchObject({ ok: true })

    harness.runtime.notifyReposChangedForRemoteClients()
    const observed: string[] = []
    for (;;) {
      const type = resultType(await harness.readerB.next('events-b'))
      observed.push(type ?? 'unknown')
      if (type === 'reposChanged' || type === 'activateWorktree') {
        break
      }
    }
    expect(observed).not.toContain('activateWorktree')
    expect(observed).toContain('worktreesChanged')

    await harness.runtime.createManagedWorktree({
      repoSelector: `id:${FOLDER_REPO_ID}`,
      name: 'headless-cli-workspace',
      activate: true
    })
    harness.runtime.notifyReposChangedForRemoteClients()
    const afterCliCreate: string[] = []
    for (;;) {
      const type = resultType(await harness.readerB.next('events-b'))
      afterCliCreate.push(type ?? 'unknown')
      if (type === 'reposChanged' || type === 'activateWorktree') {
        break
      }
    }
    expect(afterCliCreate).not.toContain('activateWorktree')
    expect(afterCliCreate).toContain('worktreesChanged')
  })

  it.each([false, true])(
    'keeps host create activation off paired observers (runHooks=%s)',
    async (runHooks) => {
      const harness = await startHarness()
      await subscribeBothClientEventStreams(harness)

      await harness.runtime.createManagedWorktree({
        repoSelector: `id:${FOLDER_REPO_ID}`,
        name: 'cli-created-workspace',
        activate: !runHooks,
        runHooks
      })

      harness.runtime.notifyReposChangedForRemoteClients()
      for (const [reader, id] of [
        [harness.readerA, 'events-a'],
        [harness.readerB, 'events-b']
      ] as const) {
        const observed: string[] = []
        for (;;) {
          const type = resultType(await reader.next(id))
          observed.push(type ?? 'unknown')
          if (type === 'reposChanged' || type === 'activateWorktree') {
            break
          }
        }
        expect(observed).not.toContain('activateWorktree')
        expect(observed).toContain('worktreesChanged')
      }
      expect(harness.activateWorktree).toHaveBeenCalled()
    }
  )

  it('keeps host worktree activation off paired observers', async () => {
    const harness = await startHarness()
    await subscribeBothClientEventStreams(harness)
    await harness.runtime.activateManagedWorktree(`id:${CLIENT_A_WORKTREE_ID}`)
    harness.runtime.notifyReposChangedForRemoteClients()
    expect(resultType(await harness.readerA.next('events-a'))).toBe('reposChanged')
    expect(resultType(await harness.readerB.next('events-b'))).toBe('reposChanged')
    expect(harness.hostSelections.worktreeId).toBe(CLIENT_A_WORKTREE_ID)
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
})
