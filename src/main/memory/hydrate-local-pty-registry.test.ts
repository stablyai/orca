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
import type { Repo } from '../../shared/types'
import type { SessionInfo } from '../daemon/types'
import type { DaemonPtyAdapter } from '../daemon/daemon-pty-adapter'
import type { Store } from '../persistence'
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

// Why: the hydrator builds its worktreeId → connectionId map through
// listRepoWorktrees(repo). The git I/O is out of scope for this unit; the mock
// also lets count tests prove repos without live sessions launch no Git work.
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
function makeStore(
  repos: { id: string; connectionId?: string | null }[] = []
): Pick<Store, 'getRepos'> {
  const built: Repo[] = repos.map((r) => ({
    id: r.id,
    path: `/tmp/${r.id}`,
    displayName: r.id,
    badgeColor: '#000000',
    addedAt: 0,
    connectionId: r.connectionId ?? null
  }))
  return { getRepos: () => built }
}

function makeProvider(sessions: SessionInfo[]): Pick<DaemonPtyAdapter, 'listSessions'> {
  return {
    listSessions: vi.fn().mockResolvedValue(sessions)
  }
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

function createDeferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolver) => {
    resolve = resolver
  })
  return { promise, resolve }
}

// Why: the module under test memoizes `hasHydrated` at module scope so it
// only runs the git/RPC pass once per process. The pty-registry module
// also stashes state in a module-level Map, so we have to load BOTH
// fresh together — otherwise the hydrator writes into one Map and the
// test reads from another. Dynamic import after vi.resetModules() returns
// a coherent pair.
async function loadFresh(): Promise<{
  hydrate: typeof HydrateFn
  listRegisteredPtys: typeof ListFn
  registerPty: typeof RegisterFn
  unregisterPty: typeof UnregisterFn
}> {
  vi.resetModules()
  const hydrateMod = await import('./hydrate-local-pty-registry')
  const registryMod = await import('./pty-registry')
  return {
    hydrate: hydrateMod.hydrateLocalPtyRegistryAtBoot,
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
    const { hydrate, listRegisteredPtys } = await loadFresh()
    getDaemonProviderMock.mockReturnValue(null)

    await hydrate(makeStore([{ id: 'repo-a' }]))

    expect(listRegisteredPtys()).toHaveLength(0)
    expect(listRepoWorktreesMock).not.toHaveBeenCalled()

    // Why: the design says the hasHydrated guard must stay false until a
    // provider is obtained, so a later macOS dock re-activation can retry.
    // Provider becomes available; second call should now perform the pass.
    const provider = makeProvider([])
    getDaemonProviderMock.mockReturnValue(provider)
    listRepoWorktreesMock.mockResolvedValue([])

    await hydrate(makeStore([{ id: 'repo-a' }]))

    expect(provider.listSessions).toHaveBeenCalledTimes(1)
    expect(listRepoWorktreesMock).not.toHaveBeenCalled()
  })

  it('catches provider.listSessions rejection and does not throw', async () => {
    const { hydrate, listRegisteredPtys } = await loadFresh()
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
    expect(listRepoWorktreesMock).not.toHaveBeenCalled()
  })

  it('does not clobber a pre-existing registry pid with a null pid from listSessions', async () => {
    const { hydrate, listRegisteredPtys, registerPty } = await loadFresh()

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
    expect(listRepoWorktreesMock).not.toHaveBeenCalled()
  })

  it('does not clobber a pty:spawn registration that arrives during worktree enumeration', async () => {
    const { hydrate, listRegisteredPtys, registerPty } = await loadFresh()
    const ptyId = 'repo-a::/local/Triton@@deadbeef'
    const provider = makeProvider([
      { sessionId: ptyId, pid: null, cwd: '/local/Triton' } as unknown as SessionInfo
    ])
    getDaemonProviderMock.mockReturnValue(provider)
    const worktrees =
      createDeferred<
        { path: string; head: string; branch: string; isBare: boolean; isMainWorktree: boolean }[]
      >()
    listRepoWorktreesMock.mockReturnValue(worktrees.promise)

    const hydration = hydrate(makeStore([{ id: 'repo-a', connectionId: null }]))
    await vi.waitFor(() => expect(listRepoWorktreesMock).toHaveBeenCalledTimes(1))
    registerPty({
      ptyId,
      worktreeId: 'repo-a::/local/Triton',
      sessionId: ptyId,
      paneKey: 'tab-1:1',
      pid: 12345
    })
    worktrees.resolve([
      { path: '/local/Triton', head: '', branch: '', isBare: false, isMainWorktree: true }
    ])
    await hydration

    expect(listRegisteredPtys()).toEqual([
      expect.objectContaining({ ptyId, pid: 12345, paneKey: 'tab-1:1' })
    ])
  })

  it('does not resurrect a daemon session that exits during worktree enumeration', async () => {
    const { hydrate, listRegisteredPtys, unregisterPty } = await loadFresh()
    const ptyId = 'repo-a::/local/Triton@@deadbeef'
    const provider = {
      listSessions: vi
        .fn()
        .mockResolvedValueOnce([
          { sessionId: ptyId, pid: 4242, cwd: '/local/Triton' } as unknown as SessionInfo
        ])
        .mockResolvedValueOnce([])
    }
    getDaemonProviderMock.mockReturnValue(provider)
    const worktrees =
      createDeferred<
        { path: string; head: string; branch: string; isBare: boolean; isMainWorktree: boolean }[]
      >()
    listRepoWorktreesMock.mockReturnValue(worktrees.promise)

    const hydration = hydrate(makeStore([{ id: 'repo-a', connectionId: null }]))
    await vi.waitFor(() => expect(listRepoWorktreesMock).toHaveBeenCalledTimes(1))
    unregisterPty(ptyId)
    worktrees.resolve([
      { path: '/local/Triton', head: '', branch: '', isBare: false, isMainWorktree: true }
    ])
    await hydration

    expect(provider.listSessions).toHaveBeenCalledTimes(2)
    expect(listRegisteredPtys()).toHaveLength(0)
  })

  it('skips SSH repos before enumerating worktrees', async () => {
    const { hydrate, listRegisteredPtys } = await loadFresh()

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
  })

  it('registers a local session whose worktree is in the store with the daemon-published pid', async () => {
    const { hydrate, listRegisteredPtys } = await loadFresh()

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
  })

  it('does not register a daemon session whose worktree was removed', async () => {
    const { hydrate, listRegisteredPtys } = await loadFresh()
    const provider = makeProvider([
      {
        sessionId: 'repo-a::/local/removed@@deadbeef',
        pid: 4242,
        cwd: '/local/removed'
      } as unknown as SessionInfo
    ])
    getDaemonProviderMock.mockReturnValue(provider)
    listRepoWorktreesMock.mockResolvedValue([
      { path: '/local/current', head: '', branch: '', isBare: false, isMainWorktree: true }
    ])

    await hydrate(makeStore([{ id: 'repo-a', connectionId: null }]))

    expect(listRepoWorktreesMock).toHaveBeenCalledTimes(1)
    expect(listRegisteredPtys()).toHaveLength(0)
  })

  it('enumerates worktrees only for repos referenced by live daemon sessions', async () => {
    const { hydrate, listRegisteredPtys } = await loadFresh()
    const repos = Array.from({ length: 100 }, (_, index) => ({ id: `repo-${index}` }))
    const activeRepoIds = ['repo-17', 'repo-83']
    const provider = makeProvider(
      activeRepoIds.map(
        (repoId, index) =>
          ({
            sessionId: `${repoId}::/local/${repoId}@@0000000${index}`,
            pid: 4000 + index,
            cwd: `/local/${repoId}`
          }) as unknown as SessionInfo
      )
    )
    getDaemonProviderMock.mockReturnValue(provider)
    listRepoWorktreesMock.mockImplementation(async (repo: Repo) => [
      {
        path: `/local/${repo.id}`,
        head: '',
        branch: '',
        isBare: false,
        isMainWorktree: true
      }
    ])

    await hydrate(makeStore(repos))

    expect(listRepoWorktreesMock).toHaveBeenCalledTimes(activeRepoIds.length)
    expect(listRepoWorktreesMock.mock.calls.map(([repo]) => (repo as Repo).id)).toEqual(
      activeRepoIds
    )
    expect(listRegisteredPtys()).toHaveLength(activeRepoIds.length)
  })

  it('scans a repo that only becomes visible on the post-enumeration re-read', async () => {
    const { hydrate, listRegisteredPtys } = await loadFresh()

    const sessionA = {
      sessionId: 'repo-a::/local/repo-a@@00000001',
      pid: 4001,
      cwd: '/local/repo-a'
    } as unknown as SessionInfo
    const sessionB = {
      sessionId: 'repo-b::/local/repo-b@@00000002',
      pid: 4002,
      cwd: '/local/repo-b'
    } as unknown as SessionInfo
    // Why: a briefly unreachable adapter can omit a session from the first
    // listing; once it reappears on the re-read its repo must still be
    // scanned and the session registered instead of silently dropped.
    const listSessions = vi
      .fn()
      .mockResolvedValueOnce([sessionA])
      .mockResolvedValue([sessionA, sessionB])
    getDaemonProviderMock.mockReturnValue({ listSessions })
    listRepoWorktreesMock.mockImplementation(async (repo: Repo) => [
      { path: `/local/${repo.id}`, head: '', branch: '', isBare: false, isMainWorktree: true }
    ])

    await hydrate(makeStore([{ id: 'repo-a' }, { id: 'repo-b' }]))

    expect(listRepoWorktreesMock.mock.calls.map(([repo]) => (repo as Repo).id)).toEqual([
      'repo-a',
      'repo-b'
    ])
    expect(listSessions).toHaveBeenCalledTimes(3)
    const registered = listRegisteredPtys()
    expect(registered.map((p) => p.ptyId).sort()).toEqual([
      'repo-a::/local/repo-a@@00000001',
      'repo-b::/local/repo-b@@00000002'
    ])
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
