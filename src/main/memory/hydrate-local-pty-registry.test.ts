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
import { resolveFolderWorkspaceHost } from '../../shared/folder-workspace-execution-host'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { Repo } from '../../shared/repo-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
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

const getLocalProjectWorktreeGitOptionsMock = vi.fn()
vi.mock('../project-runtime-git-options', () => ({
  getLocalProjectWorktreeGitOptions: (store: unknown, repo: unknown) =>
    getLocalProjectWorktreeGitOptionsMock(store, repo)
}))

// Why: the hydrator builds its worktreeId → connectionId map through
// listLocalRepoWorktreesStrict(repo). The git I/O is out of scope for this
// unit; the mock also lets count tests prove repos without live sessions
// launch no Git work.
const listLocalRepoWorktreesStrictMock = vi.fn()
vi.mock('../repo-worktrees', () => ({
  listLocalRepoWorktreesStrict: (
    repo: unknown,
    options?: { signal?: AbortSignal; wslDistro?: string }
  ) => listLocalRepoWorktreesStrictMock(repo, options)
}))

// The runtime option helper accepts Store; mocks keep this fixture scoped to hydration reads.
function makeStore(
  repos: {
    id: string
    connectionId?: string | null
    executionHostId?: Repo['executionHostId']
    kind?: Repo['kind']
    path?: string
  }[] = [],
  worktreeMeta: Record<string, WorktreeMeta> = {}
): Store {
  const built: Repo[] = repos.map((r) => ({
    id: r.id,
    path: r.path ?? `/tmp/${r.id}`,
    displayName: r.id,
    badgeColor: '#000000',
    addedAt: 0,
    connectionId: r.connectionId ?? null,
    executionHostId: r.executionHostId ?? null,
    kind: r.kind
  }))
  return {
    getRepos: () => built,
    getAllWorktreeMeta: () => worktreeMeta,
    getAllWorktreeMetaForHost: (hostId) =>
      Object.fromEntries(
        Object.entries(worktreeMeta).filter(([, meta]) => !meta.hostId || meta.hostId === hostId)
      )
  } as Store
}

function makeProvider(sessions: SessionInfo[]): Pick<DaemonPtyAdapter, 'listSessions'> {
  return {
    listSessions: vi.fn().mockResolvedValue(sessions)
  }
}

function makeProviderGroup(adapters: Pick<DaemonPtyAdapter, 'listSessions'>[]): {
  getAllAdapters: () => Pick<DaemonPtyAdapter, 'listSessions'>[]
} {
  return { getAllAdapters: () => adapters }
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
  deadlineMs: number
  gitEnumerationConcurrency: number
  listRegisteredPtys: typeof ListFn
  registerPty: typeof RegisterFn
  unregisterPty: typeof UnregisterFn
}> {
  vi.resetModules()
  const hydrateMod = await import('./hydrate-local-pty-registry')
  const registryMod = await import('./pty-registry')
  return {
    hydrate: hydrateMod.hydrateLocalPtyRegistryAtBoot,
    deadlineMs: hydrateMod.LOCAL_PTY_REGISTRY_BOOT_HYDRATION_DEADLINE_MS,
    gitEnumerationConcurrency: hydrateMod.LOCAL_PTY_REGISTRY_GIT_ENUMERATION_CONCURRENCY,
    listRegisteredPtys: registryMod.listRegisteredPtys,
    registerPty: registryMod.registerPty,
    unregisterPty: registryMod.unregisterPty
  }
}

describe('hydrateLocalPtyRegistryAtBoot', () => {
  beforeEach(() => {
    getDaemonProviderMock.mockReset()
    getLocalProjectWorktreeGitOptionsMock.mockReset().mockReturnValue({})
    listLocalRepoWorktreesStrictMock.mockReset()
  })

  it('no-op when daemon provider is null at first call (retries on later activation)', async () => {
    const { hydrate, listRegisteredPtys } = await loadFresh()
    getDaemonProviderMock.mockReturnValue(null)

    await hydrate(makeStore([{ id: 'repo-a' }]))

    expect(listRegisteredPtys()).toHaveLength(0)
    expect(listLocalRepoWorktreesStrictMock).not.toHaveBeenCalled()

    // Why: the design says the hasHydrated guard must stay false until a
    // provider is obtained, so a later macOS dock re-activation can retry.
    // Provider becomes available; second call should now perform the pass.
    const provider = makeProvider([])
    getDaemonProviderMock.mockReturnValue(provider)
    listLocalRepoWorktreesStrictMock.mockResolvedValue([])

    await hydrate(makeStore([{ id: 'repo-a' }]))

    expect(provider.listSessions).toHaveBeenCalledTimes(1)
    expect(listLocalRepoWorktreesStrictMock).not.toHaveBeenCalled()
  })

  it('catches provider.listSessions rejection and does not throw', async () => {
    const { hydrate, listRegisteredPtys } = await loadFresh()
    const provider = {
      listSessions: vi.fn().mockRejectedValue(new Error('socket EPIPE'))
    }
    getDaemonProviderMock.mockReturnValue(provider)
    listLocalRepoWorktreesStrictMock.mockResolvedValue([
      { path: '/local/Triton', isMainWorktree: true }
    ])

    // Why: the renderer-side step-2 merge fallback covers this case. The
    // hydrator must not surface the failure to the caller — it logs and
    // moves on.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(hydrate(makeStore([{ id: 'repo-a' }]))).resolves.toBeUndefined()
    warnSpy.mockRestore()

    expect(listRegisteredPtys()).toHaveLength(0)
    expect(listLocalRepoWorktreesStrictMock).not.toHaveBeenCalled()
  })

  it('coalesces concurrent calls onto one inventory attempt', async () => {
    const { hydrate } = await loadFresh()
    const inventory = createDeferred<SessionInfo[]>()
    const provider = { listSessions: vi.fn(() => inventory.promise) }
    getDaemonProviderMock.mockReturnValue(provider)

    const first = hydrate(makeStore())
    const second = hydrate(makeStore())

    expect(first).toBe(second)
    expect(provider.listSessions).toHaveBeenCalledOnce()

    inventory.resolve([])
    await first
  })

  it('retries after worktree enumeration throws', async () => {
    const { hydrate, listRegisteredPtys } = await loadFresh()
    const ptyId = 'repo-a::/local/repo-a@@00000001'
    const provider = makeProvider([
      { sessionId: ptyId, pid: 4001, cwd: '/local/repo-a' } as unknown as SessionInfo
    ])
    getDaemonProviderMock.mockReturnValue(provider)
    listLocalRepoWorktreesStrictMock
      .mockRejectedValueOnce(new Error('git unavailable'))
      .mockResolvedValue([
        { path: '/local/repo-a', head: '', branch: '', isBare: false, isMainWorktree: true }
      ])
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await hydrate(makeStore([{ id: 'repo-a' }]))
    expect(listRegisteredPtys()).toHaveLength(0)
    expect(listLocalRepoWorktreesStrictMock).toHaveBeenCalledOnce()

    await hydrate(makeStore([{ id: 'repo-a' }]))
    warnSpy.mockRestore()

    expect(listRegisteredPtys()).toEqual([expect.objectContaining({ ptyId })])
    expect(listLocalRepoWorktreesStrictMock).toHaveBeenCalledTimes(2)
  })

  it('forwards the WSL project runtime and live deadline signal to strict enumeration', async () => {
    const { hydrate } = await loadFresh()
    const ptyId = 'repo-a::/mnt/c/repo-a@@00000001'
    const store = makeStore([{ id: 'repo-a', path: '/mnt/c/repo-a' }])
    getDaemonProviderMock.mockReturnValue(
      makeProvider([
        { sessionId: ptyId, pid: 4001, cwd: '/mnt/c/repo-a' } as unknown as SessionInfo
      ])
    )
    getLocalProjectWorktreeGitOptionsMock.mockReturnValue({ wslDistro: 'Ubuntu' })
    listLocalRepoWorktreesStrictMock.mockResolvedValue([
      { path: '/mnt/c/repo-a', head: '', branch: '', isBare: false, isMainWorktree: true }
    ])

    await hydrate(store)

    const [repo, options] = listLocalRepoWorktreesStrictMock.mock.calls[0] as [
      Repo,
      { signal: AbortSignal; wslDistro?: string }
    ]
    expect(getLocalProjectWorktreeGitOptionsMock).toHaveBeenCalledWith(store, repo)
    expect(options.wslDistro).toBe('Ubuntu')
    expect(options.signal).toBeInstanceOf(AbortSignal)
    expect(options.signal.aborted).toBe(false)
  })

  it('resolves by the boot deadline and lets a later call retry stalled enumeration', async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { hydrate, deadlineMs, listRegisteredPtys } = await loadFresh()
      const ptyId = 'repo-a::/local/repo-a@@00000001'
      const provider = makeProvider([
        { sessionId: ptyId, pid: 4001, cwd: '/local/repo-a' } as unknown as SessionInfo
      ])
      const signals: AbortSignal[] = []
      getDaemonProviderMock.mockReturnValue(provider)
      listLocalRepoWorktreesStrictMock
        .mockImplementationOnce((_repo: Repo, options?: { signal?: AbortSignal }) => {
          if (options?.signal) {
            signals.push(options.signal)
          }
          return new Promise(() => {})
        })
        .mockImplementation(async (_repo: Repo, options?: { signal?: AbortSignal }) => {
          if (options?.signal) {
            signals.push(options.signal)
          }
          return [
            {
              path: '/local/repo-a',
              head: '',
              branch: '',
              isBare: false,
              isMainWorktree: true
            }
          ]
        })

      let settled = false
      const first = hydrate(makeStore([{ id: 'repo-a' }])).then(() => {
        settled = true
      })
      await vi.advanceTimersByTimeAsync(deadlineMs - 1)
      expect(settled).toBe(false)

      await vi.advanceTimersByTimeAsync(1)
      expect(settled).toBe(true)
      await first
      expect(signals[0]?.aborted).toBe(true)

      await hydrate(makeStore([{ id: 'repo-a' }]))

      expect(listLocalRepoWorktreesStrictMock).toHaveBeenCalledTimes(2)
      expect(listRegisteredPtys()).toEqual([expect.objectContaining({ ptyId })])
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      warnSpy.mockRestore()
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('bounds concurrent Git worktree enumeration', async () => {
    const { hydrate, gitEnumerationConcurrency } = await loadFresh()
    const repoCount = 6
    const gate = createDeferred<void>()
    let active = 0
    let maxActive = 0
    const sessions = Array.from({ length: repoCount }, (_, index) => {
      const repoId = `repo-${index}`
      return {
        sessionId: `${repoId}::/local/${repoId}@@0000000${index}`,
        pid: 4000 + index,
        cwd: `/local/${repoId}`
      } as unknown as SessionInfo
    })
    getDaemonProviderMock.mockReturnValue(makeProvider(sessions))
    listLocalRepoWorktreesStrictMock.mockImplementation(async (repo: Repo) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await gate.promise
      active -= 1
      return [
        { path: `/local/${repo.id}`, head: '', branch: '', isBare: false, isMainWorktree: true }
      ]
    })

    const hydration = hydrate(
      makeStore(Array.from({ length: repoCount }, (_, index) => ({ id: `repo-${index}` })))
    )
    let startedBeforeRelease = 0
    try {
      await vi.waitFor(() =>
        expect(listLocalRepoWorktreesStrictMock).toHaveBeenCalledTimes(gitEnumerationConcurrency)
      )
      startedBeforeRelease = listLocalRepoWorktreesStrictMock.mock.calls.length
    } finally {
      gate.resolve(undefined)
      await hydration
    }

    expect(startedBeforeRelease).toBe(gitEnumerationConcurrency)
    expect(maxActive).toBe(gitEnumerationConcurrency)
  })

  it('registers successful adapter rows but retries a failed adapter', async () => {
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
    const adapterA = makeProvider([sessionA])
    const adapterB = {
      listSessions: vi
        .fn()
        .mockRejectedValueOnce(new Error('legacy unavailable'))
        .mockRejectedValueOnce(new Error('legacy unavailable'))
        .mockResolvedValue([sessionB])
    }
    getDaemonProviderMock.mockReturnValue(makeProviderGroup([adapterA, adapterB]))
    listLocalRepoWorktreesStrictMock.mockImplementation(async (repo: Repo) => [
      { path: `/local/${repo.id}`, head: '', branch: '', isBare: false, isMainWorktree: true }
    ])
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = makeStore([{ id: 'repo-a' }, { id: 'repo-b' }])

    await hydrate(store)
    expect(listRegisteredPtys().map((pty) => pty.ptyId)).toEqual([sessionA.sessionId])

    await hydrate(store)
    warnSpy.mockRestore()

    expect(
      listRegisteredPtys()
        .map((pty) => pty.ptyId)
        .sort()
    ).toEqual([sessionA.sessionId, sessionB.sessionId].sort())
  })

  it('retries an all-adapter inventory failure and latches only the complete retry', async () => {
    const { hydrate } = await loadFresh()
    const firstAdapter = {
      listSessions: vi.fn().mockRejectedValueOnce(new Error('current down')).mockResolvedValue([])
    }
    const secondAdapter = {
      listSessions: vi.fn().mockRejectedValueOnce(new Error('legacy down')).mockResolvedValue([])
    }
    getDaemonProviderMock.mockReturnValue(makeProviderGroup([firstAdapter, secondAdapter]))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await hydrate(makeStore())
    await hydrate(makeStore())
    await hydrate(makeStore())
    warnSpy.mockRestore()

    expect(firstAdapter.listSessions).toHaveBeenCalledTimes(2)
    expect(secondAdapter.listSessions).toHaveBeenCalledTimes(2)
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
    listLocalRepoWorktreesStrictMock.mockResolvedValue([
      { path: '/local/Triton', head: '', branch: '', isBare: false, isMainWorktree: true }
    ])

    await hydrate(makeStore([{ id: 'repo-a', connectionId: null }]))

    const entry = listRegisteredPtys().find((p) => p.ptyId === ptyId)
    expect(entry).toBeDefined()
    expect(entry!.pid).toBe(12345)
    expect(entry!.paneKey).toBe('tab-1:1')
    expect(listLocalRepoWorktreesStrictMock).not.toHaveBeenCalled()
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
    listLocalRepoWorktreesStrictMock.mockReturnValue(worktrees.promise)

    const hydration = hydrate(makeStore([{ id: 'repo-a', connectionId: null }]))
    await vi.waitFor(() => expect(listLocalRepoWorktreesStrictMock).toHaveBeenCalledTimes(1))
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
    listLocalRepoWorktreesStrictMock.mockReturnValue(worktrees.promise)

    const hydration = hydrate(makeStore([{ id: 'repo-a', connectionId: null }]))
    await vi.waitFor(() => expect(listLocalRepoWorktreesStrictMock).toHaveBeenCalledTimes(1))
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
    listLocalRepoWorktreesStrictMock.mockResolvedValue([
      { path: '/remote/Stingray', head: '', branch: '', isBare: false, isMainWorktree: true }
    ])

    await hydrate(makeStore([{ id: 'repo-ssh', connectionId: 'ssh-conn-1' }]))

    // Why: SSH sessions execute on a remote host and their pids are not
    // visible to the local process sampler. Mirrors the spawn-time gate
    // around `registerPty` in `pty.ts`'s `pty:spawn` handler.
    expect(listRegisteredPtys()).toHaveLength(0)
    expect(listLocalRepoWorktreesStrictMock).not.toHaveBeenCalled()
  })

  it('skips paired-runtime repos even when connectionId is absent', async () => {
    const { hydrate, listRegisteredPtys } = await loadFresh()
    const provider = makeProvider([
      {
        sessionId: 'repo-runtime::/runtime/Stingray@@feedface',
        pid: 999,
        cwd: '/runtime/Stingray'
      } as unknown as SessionInfo
    ])
    getDaemonProviderMock.mockReturnValue(provider)

    await hydrate(makeStore([{ id: 'repo-runtime', executionHostId: 'runtime:environment-1' }]))

    expect(listRegisteredPtys()).toHaveLength(0)
    expect(listLocalRepoWorktreesStrictMock).not.toHaveBeenCalled()
  })

  it('registers a local session whose worktree is in the store with the daemon-published pid', async () => {
    const { hydrate, listRegisteredPtys } = await loadFresh()

    const ptyId = 'repo-a::/local/Triton@@cafebabe'
    const provider = makeProvider([
      { sessionId: ptyId, pid: 4242, cwd: '/local/Triton' } as unknown as SessionInfo
    ])
    getDaemonProviderMock.mockReturnValue(provider)
    listLocalRepoWorktreesStrictMock.mockResolvedValue([
      { path: '/local/Triton', head: '', branch: '', isBare: false, isMainWorktree: true }
    ])

    await hydrate(makeStore([{ id: 'repo-a', connectionId: null }]))

    const entry = listRegisteredPtys().find((p) => p.ptyId === ptyId)
    expect(entry).toBeDefined()
    expect(entry!.pid).toBe(4242)
    expect(entry!.worktreeId).toBe('repo-a::/local/Triton')
  })

  it('matches Windows worktree path spelling while preserving the daemon worktree id', async () => {
    const { hydrate, listRegisteredPtys } = await loadFresh()
    const worktreeId = 'repo-a::C:/Users/Neil/Orca'
    const ptyId = `${worktreeId}@@cafebabe`
    getDaemonProviderMock.mockReturnValue(
      makeProvider([
        { sessionId: ptyId, pid: 4242, cwd: 'C:/Users/Neil/Orca' } as unknown as SessionInfo
      ])
    )
    listLocalRepoWorktreesStrictMock.mockResolvedValue([
      {
        path: 'c:\\users\\neil\\orca',
        head: '',
        branch: '',
        isBare: false,
        isMainWorktree: true
      }
    ])

    await hydrate(makeStore([{ id: 'repo-a', path: 'C:\\Users\\Neil\\Orca' }]))

    expect(listRegisteredPtys()).toEqual([expect.objectContaining({ ptyId, worktreeId })])
  })

  it('fails closed when live worktrees collide on one normalized key', async () => {
    const { hydrate, listRegisteredPtys } = await loadFresh()
    const ptyId = 'repo-a::C:/Users/Neil/Orca@@cafebabe'
    getDaemonProviderMock.mockReturnValue(
      makeProvider([
        { sessionId: ptyId, pid: 4242, cwd: 'C:/Users/Neil/Orca' } as unknown as SessionInfo
      ])
    )
    listLocalRepoWorktreesStrictMock.mockResolvedValue([
      {
        path: 'C:/Users/Neil/Orca',
        head: '',
        branch: '',
        isBare: false,
        isMainWorktree: true
      },
      {
        path: 'c:\\users\\neil\\orca',
        head: '',
        branch: '',
        isBare: false,
        isMainWorktree: false
      }
    ])

    await hydrate(makeStore([{ id: 'repo-a', path: 'C:/Users/Neil/Orca' }]))

    expect(listRegisteredPtys()).toHaveLength(0)
  })

  it('matches local WSL UNC aliases without treating WSL as a remote host', async () => {
    const { hydrate, listRegisteredPtys } = await loadFresh()
    const worktreeId = 'repo-a::\\\\wsl$\\Ubuntu\\home\\neil\\orca'
    const ptyId = `${worktreeId}@@cafebabe`
    getDaemonProviderMock.mockReturnValue(
      makeProvider([
        {
          sessionId: ptyId,
          pid: 4242,
          cwd: '\\\\wsl$\\Ubuntu\\home\\neil\\orca'
        } as unknown as SessionInfo
      ])
    )
    listLocalRepoWorktreesStrictMock.mockResolvedValue([
      {
        path: '\\\\wsl.localhost\\ubuntu\\home\\neil\\orca',
        head: '',
        branch: '',
        isBare: false,
        isMainWorktree: true
      }
    ])

    await hydrate(makeStore([{ id: 'repo-a', path: '\\\\wsl$\\Ubuntu\\home\\neil\\orca' }]))

    expect(listRegisteredPtys()).toEqual([expect.objectContaining({ ptyId, worktreeId })])
  })

  it('preserves an exact repo-backed folder instance id from local-host metadata', async () => {
    const { hydrate, listRegisteredPtys } = await loadFresh()
    const instanceId =
      'folder-repo::/workspace/folder::workspace:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const ptyId = `${instanceId}@@cafebabe`
    getDaemonProviderMock.mockReturnValue(
      makeProvider([
        { sessionId: ptyId, pid: 4242, cwd: '/workspace/folder' } as unknown as SessionInfo
      ])
    )

    await hydrate(
      makeStore([{ id: 'folder-repo', kind: 'folder', path: '/workspace/folder' }], {
        [instanceId]: { hostId: 'local' } as WorktreeMeta
      })
    )

    expect(listRegisteredPtys()).toEqual([
      expect.objectContaining({ ptyId, worktreeId: instanceId })
    ])
    expect(listLocalRepoWorktreesStrictMock).not.toHaveBeenCalled()
  })

  it('accepts legacy unhosted folder-instance metadata for a uniquely local repo', async () => {
    const { hydrate, listRegisteredPtys } = await loadFresh()
    const instanceId =
      'folder-repo::/workspace/folder::workspace:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const ptyId = `${instanceId}@@cafebabe`
    getDaemonProviderMock.mockReturnValue(
      makeProvider([
        { sessionId: ptyId, pid: 4242, cwd: '/workspace/folder' } as unknown as SessionInfo
      ])
    )

    await hydrate(
      makeStore([{ id: 'folder-repo', kind: 'folder', path: '/workspace/folder' }], {
        [instanceId]: {} as WorktreeMeta
      })
    )

    expect(listRegisteredPtys()).toEqual([expect.objectContaining({ ptyId })])
  })

  it('rejects legacy folder-instance metadata when the repo id also has a remote owner', async () => {
    const { hydrate, listRegisteredPtys } = await loadFresh()
    const instanceId =
      'folder-repo::/workspace/folder::workspace:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    getDaemonProviderMock.mockReturnValue(
      makeProvider([
        {
          sessionId: `${instanceId}@@cafebabe`,
          pid: 4242,
          cwd: '/workspace/folder'
        } as unknown as SessionInfo
      ])
    )

    await hydrate(
      makeStore(
        [
          { id: 'folder-repo', kind: 'folder', path: '/workspace/folder' },
          {
            id: 'folder-repo',
            kind: 'folder',
            path: '/workspace/folder',
            executionHostId: 'runtime:environment-1'
          }
        ],
        { [instanceId]: {} as WorktreeMeta }
      )
    )

    expect(listRegisteredPtys()).toHaveLength(0)
  })

  it('accepts explicit local folder-instance metadata beside a same-id runtime owner', async () => {
    const { hydrate, listRegisteredPtys } = await loadFresh()
    const instanceId =
      'folder-repo::/workspace/folder::workspace:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const ptyId = `${instanceId}@@cafebabe`
    getDaemonProviderMock.mockReturnValue(
      makeProvider([
        { sessionId: ptyId, pid: 4242, cwd: '/workspace/folder' } as unknown as SessionInfo
      ])
    )

    await hydrate(
      makeStore(
        [
          { id: 'folder-repo', kind: 'folder', path: '/workspace/folder' },
          {
            id: 'folder-repo',
            kind: 'folder',
            path: '/workspace/folder',
            executionHostId: 'runtime:environment-1'
          }
        ],
        { [instanceId]: { hostId: 'local' } as WorktreeMeta }
      )
    )

    expect(listRegisteredPtys()).toEqual([expect.objectContaining({ ptyId })])
  })

  it('keeps true folder workspace PTY ids as an accepted hydration gap', async () => {
    const { hydrate, listRegisteredPtys } = await loadFresh()
    const workspace = {
      id: 'folder-workspace-1',
      executionHostId: 'local'
    } as FolderWorkspace
    getDaemonProviderMock.mockReturnValue(
      makeProvider([
        {
          sessionId: 'folder:folder-workspace-1@@cafebabe',
          pid: 4242,
          cwd: '/workspace/folder'
        } as unknown as SessionInfo
      ])
    )

    expect(
      resolveFolderWorkspaceHost(
        { folderWorkspaces: [workspace], projectGroups: [], repos: [] },
        workspace.id
      )
    ).toEqual({ kind: 'local' })

    await hydrate(makeStore())

    expect(listRegisteredPtys()).toHaveLength(0)
    expect(listLocalRepoWorktreesStrictMock).not.toHaveBeenCalled()
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
    listLocalRepoWorktreesStrictMock.mockResolvedValue([
      { path: '/local/current', head: '', branch: '', isBare: false, isMainWorktree: true }
    ])

    await hydrate(makeStore([{ id: 'repo-a', connectionId: null }]))

    expect(listLocalRepoWorktreesStrictMock).toHaveBeenCalledTimes(1)
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
    listLocalRepoWorktreesStrictMock.mockImplementation(async (repo: Repo) => [
      {
        path: `/local/${repo.id}`,
        head: '',
        branch: '',
        isBare: false,
        isMainWorktree: true
      }
    ])

    await hydrate(makeStore(repos))

    expect(listLocalRepoWorktreesStrictMock).toHaveBeenCalledTimes(activeRepoIds.length)
    expect(listLocalRepoWorktreesStrictMock.mock.calls.map(([repo]) => (repo as Repo).id)).toEqual(
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
    listLocalRepoWorktreesStrictMock.mockImplementation(async (repo: Repo) => [
      { path: `/local/${repo.id}`, head: '', branch: '', isBare: false, isMainWorktree: true }
    ])

    await hydrate(makeStore([{ id: 'repo-a' }, { id: 'repo-b' }]))

    expect(listLocalRepoWorktreesStrictMock.mock.calls.map(([repo]) => (repo as Repo).id)).toEqual([
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
    listLocalRepoWorktreesStrictMock.mockResolvedValue([
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
