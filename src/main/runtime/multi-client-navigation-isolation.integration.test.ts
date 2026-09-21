import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parsePairingCode } from '../../shared/pairing'
import type { RuntimeMobileSessionTabsResult } from '../../shared/runtime-types'
import type { PersistedMobileClientTabSelections } from '../../shared/persisted-state-types'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
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
  worktreeId,
  type PairedSession,
  type ResponseReader
} from './paired-client-navigation-test-harness'

vi.mock('../git/worktree', () => {
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

  /** `headless: true` models `orca serve` — no renderer notifier and no attached window. */
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
        sleepWorktree: vi.fn(),
        terminalFitOverrideChanged: vi.fn(),
        terminalDriverChanged: vi.fn()
      })
      runtime.attachWindow(1)
      runtime.markGraphReady(1)
      seedSessionTabs(runtime)
    }

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

  it('attributes workspace creation to each authenticated device across reconnect', async () => {
    const harness = await startHarness()
    const createManagedWorktree = vi
      .spyOn(harness.runtime, 'createManagedWorktree')
      .mockImplementation(async (args) => {
        const creatorProvenance = (args as unknown as Record<string, unknown>).creatorProvenance
        return {
          worktree: {
            id: worktreeId(args.name),
            creatorProvenance
          }
        } as never
      })

    send(harness.clientA, {
      id: 'status-a',
      method: 'status.get'
    })
    send(harness.clientB, {
      id: 'status-b',
      method: 'status.get'
    })
    const [statusA, statusB] = await Promise.all([
      harness.readerA.next('status-a'),
      harness.readerB.next('status-b')
    ])
    expect(statusA).toMatchObject({
      ok: true,
      result: { pairedDeviceId: harness.deviceIdA }
    })
    expect(statusB).toMatchObject({
      ok: true,
      result: { pairedDeviceId: harness.deviceIdB }
    })

    send(harness.clientA, {
      id: 'create-a',
      method: 'worktree.create',
      params: {
        repo: REPO_ID,
        name: 'created-a',
        creatorProvenance: { kind: 'paired-device', deviceId: harness.deviceIdB }
      }
    })
    send(harness.clientB, {
      id: 'create-b',
      method: 'worktree.create',
      params: { repo: REPO_ID, name: 'created-b' }
    })
    await Promise.all([harness.readerA.next('create-a'), harness.readerB.next('create-b')])
    expect(createManagedWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'created-a',
        creatorProvenance: { kind: 'paired-device', deviceId: harness.deviceIdA }
      })
    )
    expect(createManagedWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'created-b',
        creatorProvenance: { kind: 'paired-device', deviceId: harness.deviceIdB }
      })
    )

    await new Promise<void>((resolve) => {
      harness.clientA.ws.once('close', () => resolve())
      harness.clientA.ws.close()
    })
    const reconnectedA = await authenticate(harness.pairingUrlA)
    sessions.push(reconnectedA)
    const reconnectedReaderA = createReader(reconnectedA)
    readers.push(reconnectedReaderA)
    send(reconnectedA, { id: 'status-a2', method: 'status.get' })
    await expect(reconnectedReaderA.next('status-a2')).resolves.toMatchObject({
      ok: true,
      result: { pairedDeviceId: harness.deviceIdA }
    })
  })

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

    // Negative control: repeated ordinary navigation by A never reaches B or the host.
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

    // Fence: a shared-catalog event emitted after the create must be the next frame each
    // client sees. An activation frame would be delivered ahead of it on the ordered stream.
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

    // The observer must never be navigated by the creator...
    expect(observed.b).not.toContain('activateWorktree')
    expect(observed.b.at(-1)).toBe('reposChanged')
    expect(harness.activateWorktree).not.toHaveBeenCalled()
    expect(harness.hostSelections.worktreeId).toBe(HOST_WORKTREE_ID)
    // ...nor is the creator's own view driven from the host stream (it navigates from its RPC result)...
    expect(observed.a).not.toContain('activateWorktree')
    expect(observed.a.at(-1)).toBe('reposChanged')
    // ...while shared catalog state still reaches both clients.
    expect(observed.a).toContain('worktreesChanged')
    expect(observed.b).toContain('worktreesChanged')
  })

  it('does not replay a missed create activation to a reconnecting observer', async () => {
    const harness = await startHarness()
    await subscribeBothClientEventStreams(harness)

    // The observer is offline while the creator works.
    harness.readerB.dispose()
    await new Promise<void>((resolve) => {
      harness.clientB.ws.once('close', () => resolve())
      harness.clientB.ws.close()
    })

    // Why navigation 'all': a caller-scoped create emits no activation at all, so the
    // reconnect assertion below would pass vacuously — there must be a real frame to miss.
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
    // The still-connected client proves the activation really was emitted while B was down.
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

    // Why: the ready snapshot must not carry navigation intent forward; only live,
    // addressed activation is legitimate, so a reconnect can never inherit it.
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
    // Why: the CLI pairs as a runtime device but has no viewer of its own, so
    // `orca worktree create --activate` against a remote runtime sends navigation 'all'.
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

    // A headless host with no viewer of its own still reveals an in-process/CLI create.
    await harness.runtime.createManagedWorktree({
      repoSelector: `id:${FOLDER_REPO_ID}`,
      name: 'headless-cli-workspace',
      activate: true
    })
    expect(
      resultType(
        await harness.readerB.next(
          'events-b',
          (response) => resultType(response) === 'activateWorktree'
        )
      )
    ).toBe('activateWorktree')
  })

  it('normalizes a paired focused terminal.create before host-renderer activation', async () => {
    const harness = await startHarness()
    const created = { handle: 'term-b', worktreeId: CLIENT_B_WORKTREE_ID, title: null }
    const createTerminal = vi
      .spyOn(harness.runtime, 'createTerminal')
      .mockImplementation(async (_worktree, options) => {
        if (options?.presentation === 'focused') {
          harness.hostSelections.worktreeId = CLIENT_B_WORKTREE_ID
        }
        return created as never
      })
    vi.spyOn(harness.runtime, 'dedupeTerminalCreate').mockImplementation(
      async (_owner, worktree, _mutationId, _reconcile, run) => run(worktree, undefined)
    )

    send(harness.clientB, {
      id: 'terminal-create-b',
      method: 'terminal.create',
      params: {
        worktree: `id:${CLIENT_B_WORKTREE_ID}`,
        presentation: 'focused'
      }
    })
    await expect(harness.readerB.next('terminal-create-b')).resolves.toMatchObject({
      ok: true,
      result: { terminal: created }
    })
    expect(createTerminal).toHaveBeenCalledWith(
      `id:${CLIENT_B_WORKTREE_ID}`,
      expect.objectContaining({ presentation: 'background', focus: false, activate: false })
    )
    expect(harness.hostSelections).toEqual({
      worktreeId: HOST_WORKTREE_ID,
      tabId: 'host-tab'
    })
  })

  it('still reveals a host-originated create-with-activate on the host and every client', async () => {
    const harness = await startHarness()
    await subscribeBothClientEventStreams(harness)

    // Why: a headless server's only viewer is a remote client, so an in-process/CLI
    // create must keep reaching clients; only paired-client callers are scoped.
    await harness.runtime.createManagedWorktree({
      repoSelector: `id:${FOLDER_REPO_ID}`,
      name: 'cli-created-workspace',
      activate: true
    })

    const [eventA, eventB] = await Promise.all([
      harness.readerA.next('events-a', (response) => resultType(response) === 'activateWorktree'),
      harness.readerB.next('events-b', (response) => resultType(response) === 'activateWorktree')
    ])
    expect([resultType(eventA), resultType(eventB)]).toEqual([
      'activateWorktree',
      'activateWorktree'
    ])
    expect(harness.activateWorktree).toHaveBeenCalled()
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
