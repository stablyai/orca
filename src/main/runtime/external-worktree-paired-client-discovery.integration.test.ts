import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { listWorktrees, listWorktreesStrict } from '../git/worktree'
import { scheduleWorktreeBaseNotification } from '../ipc/worktree-base-directory-notifications'
import { createWorktreeHeadIdentityRefreshState } from '../ipc/worktree-head-identity-refresh'
import { setWorktreeCatalogRemoteClientNotifier } from '../ipc/watched-worktree-catalog-notification'
import { OrcaRuntimeService } from './orca-runtime'
import {
  authenticate,
  createReader,
  makeStore,
  REPO_ID,
  resultType,
  send,
  type PairedSession,
  type ResponseReader
} from './paired-client-navigation-test-harness'
import { OrcaRuntimeRpcServer } from './runtime-rpc'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn(),
  listWorktreesStrict: vi.fn()
}))

const initialWorktreePath = join(tmpdir(), 'repo')
const externalWorktreePath = join(tmpdir(), 'external-worktree')
const initialWorktree = {
  path: initialWorktreePath,
  head: 'initial-head',
  branch: 'refs/heads/main',
  isBare: false,
  isMainWorktree: true
}
const externalWorktree = {
  path: externalWorktreePath,
  head: 'external-head',
  branch: 'refs/heads/external-worktree',
  isBare: false,
  isMainWorktree: false
}
const reconnectedWorktree = {
  path: join(tmpdir(), 'reconnected-worktree'),
  head: 'reconnected-head',
  branch: 'refs/heads/reconnected-worktree',
  isBare: false,
  isMainWorktree: false
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function catalogPaths(response: Record<string, unknown>): string[] {
  return ((response.result as { worktrees?: { path: string }[] } | undefined)?.worktrees ?? []).map(
    (worktree) => worktree.path
  )
}

describe('external worktree discovery for paired clients', () => {
  const servers: OrcaRuntimeRpcServer[] = []
  const sessions: PairedSession[] = []
  const readers: ResponseReader[] = []
  const tempDirs: string[] = []

  afterEach(async () => {
    vi.useRealTimers()
    setWorktreeCatalogRemoteClientNotifier(null)
    for (const reader of readers.splice(0)) {
      reader.dispose()
    }
    for (const session of sessions.splice(0)) {
      session.ws.close()
    }
    await Promise.all(servers.splice(0).map((server) => server.stop()))
    for (const path of tempDirs.splice(0)) {
      rmSync(path, { recursive: true, force: true })
    }
    vi.clearAllMocks()
  })

  it('publishes one host-scoped catalog invalidation to two paired clients', async () => {
    vi.mocked(listWorktrees).mockResolvedValue([initialWorktree])
    vi.mocked(listWorktreesStrict).mockResolvedValue([initialWorktree])
    const runtime = new OrcaRuntimeService(makeStore() as never)
    setWorktreeCatalogRemoteClientNotifier(runtime)
    const userDataPath = mkdtempSync(join(tmpdir(), 'o-ewd-'))
    tempDirs.push(userDataPath)
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })
    servers.push(server)
    await server.start()

    const pairingUrls: string[] = []
    for (const name of ['client-a', 'client-b']) {
      const offer = server.createPairingOffer({ address: '127.0.0.1', name, scope: 'runtime' })
      if (!offer.available) {
        throw new Error('pairing_unavailable')
      }
      pairingUrls.push(offer.pairingUrl)
      const client = await authenticate(offer.pairingUrl)
      sessions.push(client)
      readers.push(createReader(client))
    }

    for (const [index, session] of sessions.entries()) {
      send(session, { id: `events-${index}`, method: 'runtime.clientEvents.subscribe' })
      await readers[index]!.next(`events-${index}`, (response) => resultType(response) === 'ready')
      send(session, {
        id: `initial-catalog-${index}`,
        method: 'worktree.list',
        params: { repo: REPO_ID, limit: 100 }
      })
      expect(catalogPaths(await readers[index]!.next(`initial-catalog-${index}`))).toEqual([
        initialWorktreePath
      ])
    }

    const legacyOffer = server.createPairingOffer({
      address: '127.0.0.1',
      name: 'event-ignoring-client',
      scope: 'runtime'
    })
    if (!legacyOffer.available) {
      throw new Error('pairing_unavailable')
    }
    const legacyClient = await authenticate(legacyOffer.pairingUrl)
    const legacyReader = createReader(legacyClient)
    sessions.push(legacyClient)
    readers.push(legacyReader)
    send(legacyClient, {
      id: 'legacy-initial-catalog',
      method: 'worktree.list',
      params: { repo: REPO_ID, limit: 100 }
    })
    expect(catalogPaths(await legacyReader.next('legacy-initial-catalog'))).toEqual([
      initialWorktreePath
    ])

    vi.mocked(listWorktrees).mockResolvedValue([initialWorktree, externalWorktree])
    vi.mocked(listWorktreesStrict).mockResolvedValue([initialWorktree, externalWorktree])

    const sendToHostRenderer = vi.fn()
    const watch = {
      key: 'base:repo-1',
      kind: 'base' as const,
      path: tmpdir(),
      repos: new Map(),
      mainWindow: {
        isDestroyed: () => false,
        webContents: { send: sendToHostRenderer }
      },
      notifyTimer: null,
      pendingStructureRepoIds: new Set<string>(),
      pendingGitStatusRepoIds: new Set<string>(),
      pendingHeadIdentityRepoIds: new Set<string>(),
      headIdentityRefresh: createWorktreeHeadIdentityRefreshState(),
      disposed: false
    }
    vi.useFakeTimers()
    scheduleWorktreeBaseNotification(watch as never, { structureRepoIds: [REPO_ID] })
    scheduleWorktreeBaseNotification(watch as never, { structureRepoIds: [REPO_ID] })
    await vi.advanceTimersByTimeAsync(250)
    vi.useRealTimers()

    expect(sendToHostRenderer).toHaveBeenCalledTimes(1)
    expect(sendToHostRenderer).toHaveBeenCalledWith('worktrees:changed', { repoId: REPO_ID })

    runtime.notifyReposChangedForRemoteClients()
    for (const [index, reader] of readers.slice(0, 2).entries()) {
      const observed: string[] = []
      for (;;) {
        const type = resultType(await reader.next(`events-${index}`)) ?? 'unknown'
        observed.push(type)
        if (type === 'reposChanged') {
          break
        }
      }
      expect(observed).toEqual(['worktreesChanged', 'reposChanged'])
    }

    for (const [index, session] of sessions.slice(0, 2).entries()) {
      send(session, {
        id: `refreshed-catalog-${index}`,
        method: 'worktree.list',
        params: { repo: REPO_ID, limit: 100 }
      })
      expect(catalogPaths(await readers[index]!.next(`refreshed-catalog-${index}`))).toEqual([
        initialWorktreePath,
        externalWorktreePath
      ])
    }

    send(legacyClient, {
      id: 'legacy-explicit-refresh',
      method: 'worktree.list',
      params: { repo: REPO_ID, limit: 100 }
    })
    expect(catalogPaths(await legacyReader.next('legacy-explicit-refresh'))).toEqual([
      initialWorktreePath,
      externalWorktreePath
    ])

    const disconnectedSession = sessions.splice(1, 1)[0]!
    const disconnectedReader = readers.splice(1, 1)[0]!
    disconnectedReader.dispose()
    await new Promise<void>((resolve) => {
      disconnectedSession.ws.once('close', () => resolve())
      disconnectedSession.ws.close()
    })
    vi.mocked(listWorktrees).mockResolvedValue([
      initialWorktree,
      externalWorktree,
      reconnectedWorktree
    ])
    vi.mocked(listWorktreesStrict).mockResolvedValue([
      initialWorktree,
      externalWorktree,
      reconnectedWorktree
    ])

    vi.useFakeTimers()
    scheduleWorktreeBaseNotification(watch as never, { structureRepoIds: [REPO_ID] })
    await vi.advanceTimersByTimeAsync(250)
    vi.useRealTimers()
    await expect(
      readers[0]!.next('events-0', (response) => resultType(response) === 'worktreesChanged')
    ).resolves.toMatchObject({ result: { repoId: REPO_ID } })

    const reconnectedSession = await authenticate(pairingUrls[1]!)
    const reconnectedReader = createReader(reconnectedSession)
    sessions.push(reconnectedSession)
    readers.push(reconnectedReader)
    send(reconnectedSession, {
      id: 'events-reconnected',
      method: 'runtime.clientEvents.subscribe'
    })
    await reconnectedReader.next(
      'events-reconnected',
      (response) => resultType(response) === 'ready'
    )
    send(reconnectedSession, {
      id: 'reconnected-catalog',
      method: 'worktree.list',
      params: { repo: REPO_ID, limit: 100 }
    })
    expect(catalogPaths(await reconnectedReader.next('reconnected-catalog'))).toEqual([
      initialWorktreePath,
      externalWorktreePath,
      reconnectedWorktree.path
    ])

    runtime.notifyReposChangedForRemoteClients()
    expect(resultType(await reconnectedReader.next('events-reconnected'))).toBe('reposChanged')
  })

  it('retries invalidated owner and joined scans before returning their stale snapshot', async () => {
    const firstScanStarted = deferred<void>()
    const releaseFirstScan = deferred<void>()
    let scanCount = 0
    vi.mocked(listWorktrees).mockResolvedValue([initialWorktree])
    vi.mocked(listWorktreesStrict).mockResolvedValue([initialWorktree, externalWorktree])
    const runtime = new OrcaRuntimeService(makeStore() as never)
    setWorktreeCatalogRemoteClientNotifier(runtime)
    const userDataPath = mkdtempSync(join(tmpdir(), 'o-ewd-race-'))
    tempDirs.push(userDataPath)
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })
    servers.push(server)
    await server.start()
    const clients: PairedSession[] = []
    const raceReaders: ResponseReader[] = []
    for (const name of ['race-client-a', 'race-client-b']) {
      const offer = server.createPairingOffer({ address: '127.0.0.1', name, scope: 'runtime' })
      if (!offer.available) {
        throw new Error('pairing_unavailable')
      }
      const client = await authenticate(offer.pairingUrl)
      const reader = createReader(client)
      clients.push(client)
      raceReaders.push(reader)
      sessions.push(client)
      readers.push(reader)
    }
    for (const [index, client] of clients.entries()) {
      send(client, { id: `race-events-${index}`, method: 'runtime.clientEvents.subscribe' })
      await raceReaders[index].next(
        `race-events-${index}`,
        (response) => resultType(response) === 'ready'
      )
    }

    runtime.notifyWorktreeCatalogChangedForRemoteClients(REPO_ID)
    await Promise.all(
      raceReaders.map((reader, index) =>
        reader.next(
          `race-events-${index}`,
          (response) => resultType(response) === 'worktreesChanged'
        )
      )
    )
    let inventory = [initialWorktree]
    vi.mocked(listWorktreesStrict).mockClear()
    vi.mocked(listWorktreesStrict).mockImplementation(async () => {
      scanCount += 1
      if (scanCount === 1) {
        const captured = [...inventory]
        firstScanStarted.resolve()
        await releaseFirstScan.promise
        return captured
      }
      return inventory
    })

    for (const [index, client] of clients.entries()) {
      send(client, {
        id: `overlapping-catalog-${index}`,
        method: 'worktree.list',
        params: { repo: REPO_ID, limit: 100 }
      })
    }
    await firstScanStarted.promise
    inventory = [initialWorktree, externalWorktree]
    expect(listWorktreesStrict).toHaveBeenCalledOnce()

    const watch = {
      key: 'base:repo-race',
      kind: 'base' as const,
      path: tmpdir(),
      repos: new Map(),
      mainWindow: {
        isDestroyed: () => false,
        webContents: { send: vi.fn() }
      },
      notifyTimer: null,
      pendingStructureRepoIds: new Set<string>(),
      pendingGitStatusRepoIds: new Set<string>(),
      pendingHeadIdentityRepoIds: new Set<string>(),
      headIdentityRefresh: createWorktreeHeadIdentityRefreshState(),
      disposed: false
    }
    vi.useFakeTimers()
    scheduleWorktreeBaseNotification(watch as never, { structureRepoIds: [REPO_ID] })
    await vi.advanceTimersByTimeAsync(250)
    vi.useRealTimers()
    await Promise.all(
      raceReaders.map((reader, index) =>
        expect(
          reader.next(
            `race-events-${index}`,
            (response) => resultType(response) === 'worktreesChanged'
          )
        ).resolves.toMatchObject({ result: { repoId: REPO_ID } })
      )
    )

    releaseFirstScan.resolve()
    await Promise.all(
      raceReaders.map(async (reader, index) => {
        expect(catalogPaths(await reader.next(`overlapping-catalog-${index}`))).toEqual([
          initialWorktreePath,
          externalWorktreePath
        ])
      })
    )
    expect(listWorktreesStrict).toHaveBeenCalledTimes(2)
  })

  it('does not publish an owner-blind event for colliding local and SSH repo IDs', async () => {
    const store = makeStore()
    const localRepo = store.getRepos().find((repo) => repo.id === REPO_ID)
    if (!localRepo) {
      throw new Error('local_repo_missing')
    }
    const collidingRepos = [
      ...store.getRepos(),
      { ...localRepo, path: '/remote/repo', connectionId: 'ssh-target-1' }
    ]
    const runtime = new OrcaRuntimeService({
      ...store,
      getRepo: (id: string) => collidingRepos.find((repo) => repo.id === id),
      getRepos: () => collidingRepos
    } as never)
    setWorktreeCatalogRemoteClientNotifier(runtime)
    const userDataPath = mkdtempSync(join(tmpdir(), 'o-ewd-collision-'))
    tempDirs.push(userDataPath)
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })
    servers.push(server)
    await server.start()
    const offer = server.createPairingOffer({
      address: '127.0.0.1',
      name: 'collision-client',
      scope: 'runtime'
    })
    if (!offer.available) {
      throw new Error('pairing_unavailable')
    }
    const client = await authenticate(offer.pairingUrl)
    const reader = createReader(client)
    sessions.push(client)
    readers.push(reader)
    send(client, { id: 'collision-events', method: 'runtime.clientEvents.subscribe' })
    await reader.next('collision-events', (response) => resultType(response) === 'ready')

    const sendToHostRenderer = vi.fn()
    const watch = {
      key: 'base:local-repo-collision',
      kind: 'base' as const,
      path: tmpdir(),
      repos: new Map(),
      mainWindow: {
        isDestroyed: () => false,
        webContents: { send: sendToHostRenderer }
      },
      notifyTimer: null,
      pendingStructureRepoIds: new Set<string>(),
      pendingGitStatusRepoIds: new Set<string>(),
      pendingHeadIdentityRepoIds: new Set<string>(),
      headIdentityRefresh: createWorktreeHeadIdentityRefreshState(),
      disposed: false
    }
    vi.useFakeTimers()
    scheduleWorktreeBaseNotification(watch as never, { structureRepoIds: [REPO_ID] })
    await vi.advanceTimersByTimeAsync(250)
    vi.useRealTimers()

    expect(sendToHostRenderer).toHaveBeenCalledWith('worktrees:changed', { repoId: REPO_ID })
    runtime.notifyReposChangedForRemoteClients()
    expect(resultType(await reader.next('collision-events'))).toBe('reposChanged')
  })

  it('does not publish a host-blind event for a nested SSH watcher', async () => {
    const runtime = new OrcaRuntimeService(makeStore() as never)
    setWorktreeCatalogRemoteClientNotifier(runtime)
    const userDataPath = mkdtempSync(join(tmpdir(), 'o-ewd-ssh-owner-'))
    tempDirs.push(userDataPath)
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })
    servers.push(server)
    await server.start()
    const offer = server.createPairingOffer({
      address: '127.0.0.1',
      name: 'nested-ssh-client',
      scope: 'runtime'
    })
    if (!offer.available) {
      throw new Error('pairing_unavailable')
    }
    const client = await authenticate(offer.pairingUrl)
    const reader = createReader(client)
    sessions.push(client)
    readers.push(reader)
    send(client, { id: 'ssh-events', method: 'runtime.clientEvents.subscribe' })
    await reader.next('ssh-events', (response) => resultType(response) === 'ready')

    const sendToHostRenderer = vi.fn()
    const watch = {
      key: 'ssh:repo-collision',
      kind: 'base' as const,
      path: '/remote/worktrees',
      connectionId: 'ssh-target-1',
      repos: new Map(),
      mainWindow: {
        isDestroyed: () => false,
        webContents: { send: sendToHostRenderer }
      },
      notifyTimer: null,
      pendingStructureRepoIds: new Set<string>(),
      pendingGitStatusRepoIds: new Set<string>(),
      pendingHeadIdentityRepoIds: new Set<string>(),
      headIdentityRefresh: createWorktreeHeadIdentityRefreshState(),
      disposed: false
    }
    vi.useFakeTimers()
    scheduleWorktreeBaseNotification(watch as never, { structureRepoIds: [REPO_ID] })
    await vi.advanceTimersByTimeAsync(250)
    vi.useRealTimers()

    expect(sendToHostRenderer).toHaveBeenCalledWith('worktrees:changed', { repoId: REPO_ID })
    runtime.notifyReposChangedForRemoteClients()
    expect(resultType(await reader.next('ssh-events'))).toBe('reposChanged')
  })

  it('keeps the shared runtime publication valid without a headed renderer', async () => {
    vi.mocked(listWorktrees).mockResolvedValue([initialWorktree])
    vi.mocked(listWorktreesStrict).mockResolvedValue([initialWorktree])
    const runtime = new OrcaRuntimeService(makeStore() as never)
    const userDataPath = mkdtempSync(join(tmpdir(), 'o-ewd-h-'))
    tempDirs.push(userDataPath)
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })
    servers.push(server)
    await server.start()
    const offer = server.createPairingOffer({
      address: '127.0.0.1',
      name: 'headless-client',
      scope: 'runtime'
    })
    if (!offer.available) {
      throw new Error('pairing_unavailable')
    }
    const client = await authenticate(offer.pairingUrl)
    const reader = createReader(client)
    sessions.push(client)
    readers.push(reader)
    send(client, { id: 'headless-events', method: 'runtime.clientEvents.subscribe' })
    await reader.next('headless-events', (response) => resultType(response) === 'ready')
    send(client, {
      id: 'headless-initial-catalog',
      method: 'worktree.list',
      params: { repo: REPO_ID, limit: 100 }
    })
    expect(catalogPaths(await reader.next('headless-initial-catalog'))).toEqual([
      initialWorktreePath
    ])

    vi.mocked(listWorktrees).mockResolvedValue([initialWorktree, externalWorktree])
    vi.mocked(listWorktreesStrict).mockResolvedValue([initialWorktree, externalWorktree])
    runtime.notifyWorktreeCatalogChangedForRemoteClients(REPO_ID)

    await expect(
      reader.next('headless-events', (response) => resultType(response) === 'worktreesChanged')
    ).resolves.toMatchObject({ result: { repoId: REPO_ID } })
    send(client, {
      id: 'headless-refreshed-catalog',
      method: 'worktree.list',
      params: { repo: REPO_ID, limit: 100 }
    })
    expect(catalogPaths(await reader.next('headless-refreshed-catalog'))).toEqual([
      initialWorktreePath,
      externalWorktreePath
    ])
  })
})
