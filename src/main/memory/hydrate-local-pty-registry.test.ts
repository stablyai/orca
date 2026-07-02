/**
 * Tests for boot-time pty-registry hydration.
 *
 * Why these scenarios:
 *   - Daemon offline → graceful degradation. The renderer-side merge
 *     fallback should still work; we just lose the coverage win for that
 *     boot. Hydrator must catch and log, not throw.
 *   - Pid-write ordering. `pty:spawn` is the authoritative writer; if it
 *     wrote pid=12345 before the boot pass ran, the boot pass must NOT
 *     clobber that with `pid: null` from a pre-publish daemon listSessions.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo, WorktreeMeta } from '../../shared/types'
import type { SessionInfo } from '../daemon/types'
import type { DaemonPtyAdapter } from '../daemon/daemon-pty-adapter'
import { DaemonPtyRouter } from '../daemon/daemon-pty-router'
import type { Store } from '../persistence'
import type { getLocalPtyRegistryHydrationDebugSnapshot as GetHydrationDebugSnapshotFn } from './hydrate-local-pty-registry'
import type { hydrateLocalPtyRegistryAtBoot as HydrateFn } from './hydrate-local-pty-registry'
import type {
  listRegisteredPtys as ListFn,
  registerPty as RegisterFn,
  unregisterPty as UnregisterFn
} from './pty-registry'

const LARGE_SESSION_COUNT = 150_000

// Why: the hydrator pulls the daemon provider through this module-level
// getter. Stubbing it lets us drive the offline / throwing / live paths
// without spinning up real sockets.
const getDaemonProviderMock = vi.fn()
vi.mock('../daemon/daemon-init', () => ({
  getDaemonProvider: () => getDaemonProviderMock()
}))

// Why: the hydrator builds its worktreeId → connectionId map by calling
// listRepoWorktrees(repo) for every repo in the store. The git I/O is
// out of scope for this unit; mock returns whatever the test wants.
const listRepoWorktreesMock = vi.fn()
vi.mock('../repo-worktrees', () => ({
  listRepoWorktrees: (repo: unknown) => listRepoWorktreesMock(repo)
}))

// Why: hydrateLocalPtyRegistryAtBoot accepts `Pick<Store, 'getRepos'>` and
// the hydrator only reads `id` + `connectionId` off each Repo, but Repo's
// required fields (path, displayName, badgeColor, addedAt) still have to be
// present at the type level. Filling them with placeholder values keeps the
// test schema-compliant without coupling to anything the hydrator doesn't
// touch.
type HydrationTestStore = Pick<Store, 'getRepos'> & {
  getWorktreeMeta: (worktreeId: string) => WorktreeMeta | undefined
}

function makeStore(
  repos: { id: string; connectionId?: string | null }[] = [],
  worktreeMetaById: Record<string, Partial<WorktreeMeta>> = {}
): HydrationTestStore {
  const built: Repo[] = repos.map((r) => ({
    id: r.id,
    path: `/tmp/${r.id}`,
    displayName: r.id,
    badgeColor: '#000000',
    addedAt: 0,
    connectionId: r.connectionId ?? null
  }))
  return {
    getRepos: () => built,
    getWorktreeMeta: (worktreeId: string) =>
      worktreeMetaById[worktreeId] as WorktreeMeta | undefined
  }
}

function makeProvider(sessions: SessionInfo[]): Pick<DaemonPtyAdapter, 'listSessions'> {
  return {
    listSessions: vi.fn().mockResolvedValue(sessions)
  }
}

function makeAdapter(sessions: SessionInfo[]): DaemonPtyAdapter {
  return {
    listSessions: vi.fn().mockResolvedValue(sessions),
    onData: vi.fn(() => () => {}),
    onExit: vi.fn(() => () => {})
  } as unknown as DaemonPtyAdapter
}

function makeRejectingAdapter(error: Error): DaemonPtyAdapter {
  return {
    listSessions: vi.fn().mockRejectedValue(error),
    onData: vi.fn(() => () => {}),
    onExit: vi.fn(() => () => {})
  } as unknown as DaemonPtyAdapter
}

function makeLocalSessions(repoId: string, worktreePath: string, count: number): SessionInfo[] {
  const sessions: SessionInfo[] = []
  for (let index = 0; index < count; index += 1) {
    const suffix = index.toString(16).padStart(8, '0')
    sessions.push({
      sessionId: `${repoId}::${worktreePath}@@${suffix}`,
      pid: 1000 + index,
      cwd: worktreePath
    } as unknown as SessionInfo)
  }
  return sessions
}

// Why: the module under test memoizes `hasHydrated` at module scope so it
// only runs the git/RPC pass once per process. The pty-registry module
// also stashes state in a module-level Map, so we have to load BOTH
// fresh together — otherwise the hydrator writes into one Map and the
// test reads from another. Dynamic import after vi.resetModules() returns
// a coherent pair.
async function loadFresh(): Promise<{
  hydrate: typeof HydrateFn
  getHydrationDebugSnapshot: typeof GetHydrationDebugSnapshotFn
  listRegisteredPtys: typeof ListFn
  registerPty: typeof RegisterFn
  unregisterPty: typeof UnregisterFn
}> {
  vi.resetModules()
  const hydrateMod = await import('./hydrate-local-pty-registry')
  const registryMod = await import('./pty-registry')
  return {
    hydrate: hydrateMod.hydrateLocalPtyRegistryAtBoot,
    getHydrationDebugSnapshot: hydrateMod.getLocalPtyRegistryHydrationDebugSnapshot,
    listRegisteredPtys: registryMod.listRegisteredPtys,
    registerPty: registryMod.registerPty,
    unregisterPty: registryMod.unregisterPty
  }
}

describe('hydrateLocalPtyRegistryAtBoot', () => {
  beforeEach(() => {
    getDaemonProviderMock.mockReset()
    listRepoWorktreesMock.mockReset()
  })

  it('no-op when daemon provider is null at first call (retries on later activation)', async () => {
    const { hydrate, getHydrationDebugSnapshot, listRegisteredPtys } = await loadFresh()
    getDaemonProviderMock.mockReturnValue(null)

    await hydrate(makeStore([{ id: 'repo-a' }]))

    expect(listRegisteredPtys()).toHaveLength(0)
    expect(listRepoWorktreesMock).not.toHaveBeenCalled()
    expect(getHydrationDebugSnapshot()).toMatchObject({
      phase: 'provider-unavailable',
      hasHydrated: false,
      repoCount: 0,
      sessionsScannedCount: 0
    })

    // Why: the design says the hasHydrated guard must stay false until a
    // provider is obtained, so a later macOS dock re-activation can retry.
    // Provider becomes available; second call should now perform the pass.
    const provider = makeProvider([])
    getDaemonProviderMock.mockReturnValue(provider)
    listRepoWorktreesMock.mockResolvedValue([])

    await hydrate(makeStore([{ id: 'repo-a' }]))

    expect(provider.listSessions).toHaveBeenCalledTimes(1)
    expect(getHydrationDebugSnapshot()).toMatchObject({
      phase: 'complete',
      hasHydrated: true,
      repoCount: 1,
      adapterCount: 1
    })
  })

  it('catches provider.listSessions rejection and does not throw', async () => {
    const { hydrate, getHydrationDebugSnapshot, listRegisteredPtys } = await loadFresh()
    const provider = {
      listSessions: vi.fn().mockRejectedValue(new Error('socket EPIPE'))
    }
    getDaemonProviderMock.mockReturnValue(provider)
    listRepoWorktreesMock.mockResolvedValue([{ path: '/local/Triton', isMainWorktree: true }])

    // Why: the renderer-side step-2 merge fallback covers this case. The
    // hydrator must not surface the failure to the caller — it logs and
    // moves on.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(hydrate(makeStore([{ id: 'repo-a' }]))).resolves.toBeUndefined()
    warnSpy.mockRestore()

    expect(listRegisteredPtys()).toHaveLength(0)
    expect(getHydrationDebugSnapshot()).toMatchObject({
      phase: 'partial',
      failedAdapterCount: 1,
      registeredCount: 0
    })
  })

  it('does not clobber a pre-existing registry pid with a null pid from listSessions', async () => {
    const { hydrate, getHydrationDebugSnapshot, listRegisteredPtys, registerPty } =
      await loadFresh()

    const ptyId = 'repo-a::/local/Triton@@deadbeef'
    // Why: simulate the spawn-time path having already written the row
    // with the real pid before the boot pass runs. The boot pass must
    // skip rather than overwriting with a stale pid.
    registerPty({
      ptyId,
      worktreeId: 'repo-a::/local/Triton',
      sessionId: ptyId,
      paneKey: 'tab-1:1',
      pid: 12345
    })

    const provider = makeProvider([
      // pid is null — typical of a session whose daemon-side pid hasn't
      // been published yet. If the hydrator unconditionally re-registered,
      // the live row would degrade to pid: null and the collector would
      // stop sampling it on the next tick.
      { sessionId: ptyId, pid: null, cwd: '/local/Triton' } as unknown as SessionInfo
    ])
    getDaemonProviderMock.mockReturnValue(provider)
    listRepoWorktreesMock.mockResolvedValue([
      { path: '/local/Triton', head: '', branch: '', isBare: false, isMainWorktree: true }
    ])

    await hydrate(makeStore([{ id: 'repo-a', connectionId: null }]))

    const entry = listRegisteredPtys().find((p) => p.ptyId === ptyId)
    expect(entry).toBeDefined()
    expect(entry!.pid).toBe(12345)
    expect(entry!.paneKey).toBe('tab-1:1')
    expect(getHydrationDebugSnapshot()).toMatchObject({
      alreadyRegisteredCount: 1,
      registeredCount: 0,
      sessionsScannedCount: 1
    })
  })

  it('skips SSH repos before enumerating worktrees', async () => {
    const { hydrate, getHydrationDebugSnapshot, listRegisteredPtys } = await loadFresh()

    const ptyId = 'repo-ssh::/remote/Stingray@@feedface'
    const provider = makeProvider([
      { sessionId: ptyId, pid: 999, cwd: '/remote/Stingray' } as unknown as SessionInfo
    ])
    getDaemonProviderMock.mockReturnValue(provider)
    listRepoWorktreesMock.mockResolvedValue([
      { path: '/remote/Stingray', head: '', branch: '', isBare: false, isMainWorktree: true }
    ])

    await hydrate(makeStore([{ id: 'repo-ssh', connectionId: 'ssh-conn-1' }]))

    // Why: SSH sessions execute on a remote host and their pids are not
    // visible to the local process sampler. Mirrors the spawn-time gate
    // around `registerPty` in `pty.ts`'s `pty:spawn` handler.
    expect(listRegisteredPtys()).toHaveLength(0)
    expect(listRepoWorktreesMock).not.toHaveBeenCalled()
    expect(getHydrationDebugSnapshot()).toMatchObject({
      skippedRemoteRepoCount: 1,
      worktreeEnumerationCount: 0,
      skippedUnknownWorktreeCount: 1
    })
  })

  it('registers a local session whose worktree is in the store with the daemon-published pid', async () => {
    const { hydrate, getHydrationDebugSnapshot, listRegisteredPtys } = await loadFresh()

    const ptyId = 'repo-a::/local/Triton@@cafebabe'
    const provider = makeProvider([
      { sessionId: ptyId, pid: 4242, cwd: '/local/Triton' } as unknown as SessionInfo
    ])
    getDaemonProviderMock.mockReturnValue(provider)
    listRepoWorktreesMock.mockResolvedValue([
      { path: '/local/Triton', head: '', branch: '', isBare: false, isMainWorktree: true }
    ])

    await hydrate(makeStore([{ id: 'repo-a', connectionId: null }]))

    const entry = listRegisteredPtys().find((p) => p.ptyId === ptyId)
    expect(entry).toBeDefined()
    expect(entry!.pid).toBe(4242)
    expect(entry!.worktreeId).toBe('repo-a::/local/Triton')
    expect(getHydrationDebugSnapshot()).toMatchObject({
      phase: 'complete',
      repoCount: 1,
      localRepoCount: 1,
      worktreeEnumerationCount: 1,
      worktreeCount: 1,
      adapterCount: 1,
      sessionsScannedCount: 1,
      registeredCount: 1,
      failedAdapterCount: 0
    })
    expect(getHydrationDebugSnapshot().elapsedMs).not.toBeNull()
  })

  it('registers a daemon session minted under a prior worktree id to the current worktree', async () => {
    const { hydrate, getHydrationDebugSnapshot, listRegisteredPtys } = await loadFresh()

    const currentWorktreeId = 'repo-a::/local/NewTriton'
    const priorWorktreeId = 'repo-a::/local/OldTriton'
    const ptyId = `${priorWorktreeId}@@cafebabe`
    const provider = makeProvider([
      { sessionId: ptyId, pid: 4242, cwd: '/local/OldTriton' } as unknown as SessionInfo
    ])
    getDaemonProviderMock.mockReturnValue(provider)
    listRepoWorktreesMock.mockResolvedValue([
      { path: '/local/NewTriton', head: '', branch: '', isBare: false, isMainWorktree: true }
    ])

    await hydrate(
      makeStore([{ id: 'repo-a', connectionId: null }], {
        [currentWorktreeId]: { priorWorktreeIds: [priorWorktreeId] }
      })
    )

    const entry = listRegisteredPtys().find((p) => p.ptyId === ptyId)
    expect(entry).toBeDefined()
    expect(entry!.pid).toBe(4242)
    expect(entry!.sessionId).toBe(ptyId)
    expect(entry!.worktreeId).toBe(currentWorktreeId)
    expect(getHydrationDebugSnapshot()).toMatchObject({
      phase: 'complete',
      sessionsScannedCount: 1,
      registeredCount: 1,
      skippedUnknownWorktreeCount: 0
    })
  })

  it('keeps successful adapter hydration observable when one adapter fails', async () => {
    const { hydrate, getHydrationDebugSnapshot, listRegisteredPtys } = await loadFresh()
    const ptyId = 'repo-a::/local/Triton@@cafebabe'
    const provider = {
      getAllAdapters: () => [
        makeAdapter([
          { sessionId: ptyId, pid: 4242, cwd: '/local/Triton' } as unknown as SessionInfo
        ]),
        makeRejectingAdapter(new Error('legacy unavailable'))
      ]
    }
    getDaemonProviderMock.mockReturnValue(provider)
    listRepoWorktreesMock.mockResolvedValue([
      { path: '/local/Triton', head: '', branch: '', isBare: false, isMainWorktree: true }
    ])

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await hydrate(makeStore([{ id: 'repo-a', connectionId: null }]))
    warnSpy.mockRestore()

    expect(listRegisteredPtys()).toHaveLength(1)
    expect(getHydrationDebugSnapshot()).toMatchObject({
      phase: 'partial',
      adapterCount: 2,
      sessionsScannedCount: 1,
      registeredCount: 1,
      failedAdapterCount: 1
    })
  })

  it('hydrates through a real daemon router adapter inventory', async () => {
    const { hydrate, getHydrationDebugSnapshot, listRegisteredPtys } = await loadFresh()
    const ptyId = 'repo-a::/local/Triton@@cafebabe'
    const provider = new DaemonPtyRouter({
      current: makeAdapter([
        { sessionId: ptyId, pid: 4242, cwd: '/local/Triton' } as unknown as SessionInfo
      ]),
      legacy: []
    })
    getDaemonProviderMock.mockReturnValue(provider)
    listRepoWorktreesMock.mockResolvedValue([
      { path: '/local/Triton', head: '', branch: '', isBare: false, isMainWorktree: true }
    ])

    await hydrate(makeStore([{ id: 'repo-a', connectionId: null }]))

    expect(listRegisteredPtys()).toHaveLength(1)
    expect(getHydrationDebugSnapshot()).toMatchObject({
      phase: 'complete',
      adapterCount: 1,
      sessionsScannedCount: 1,
      registeredCount: 1
    })
  })

  it('hydrates large daemon session lists', async () => {
    const { hydrate, listRegisteredPtys } = await loadFresh()

    const sessions = makeLocalSessions('repo-a', '/local/Triton', LARGE_SESSION_COUNT)
    const provider = makeProvider(sessions)
    getDaemonProviderMock.mockReturnValue(provider)
    listRepoWorktreesMock.mockResolvedValue([
      { path: '/local/Triton', head: '', branch: '', isBare: false, isMainWorktree: true }
    ])

    await hydrate(makeStore([{ id: 'repo-a', connectionId: null }]))

    const registered = listRegisteredPtys()
    expect(registered).toHaveLength(LARGE_SESSION_COUNT)
    expect(registered[0]?.ptyId).toBe('repo-a::/local/Triton@@00000000')
    expect(registered.at(-1)?.ptyId).toBe(
      `repo-a::/local/Triton@@${(LARGE_SESSION_COUNT - 1).toString(16).padStart(8, '0')}`
    )
  })
})
