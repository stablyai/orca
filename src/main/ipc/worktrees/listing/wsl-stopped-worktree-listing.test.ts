import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { DetectedWorktreeListResult } from '../../../../shared/worktree/types'
import type { Store } from '../../../persistence/loading-store/store'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'

const mocks = vi.hoisted(() => ({ listDetectedGitWorktrees: vi.fn(), runProcess: vi.fn() }))

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  app: { getPath: () => '/tmp/orca-test' }
}))
vi.mock('./detected-worktree-scan-cache', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listDetectedGitWorktrees: mocks.listDetectedGitWorktrees
}))
// Any `wsl --list --running` probe would land here; a deferred re-scan must never make one.
vi.mock('@orca/process-host', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runProcess: mocks.runProcess
}))

const { listDetectedWorktreesForCapturedRepo } = await import('./detected-provider-listing')
const { setWslStoppedWorktreeRescanNotifier } = await import('./wsl-stopped-worktree-listing')
const { WslDistroStoppedError, WslDistroUnverifiableError } =
  await import('../../../wsl/wsl-unc-access-gate')
const { _resetWslBackgroundDistroGateForTests, noteWslDistroWoken, noteWslDistrosRunning } =
  await import('../../../wsl-background-distro-gate')
const { scanWorktreesStartingWslDistro } = await import('./wsl-distro-starting-scan')
const { isWslUserActFor } = await import('../../../wsl/wsl-user-act-scope')
const { _pendingWslStoppedWorktreeRescanCount, _resetWslStoppedWorktreeRescansForTests } =
  await import('../../../wsl-stopped-worktree-rescan-registry')

const REPO_PATH = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'
const FEATURE_PATH = '\\\\wsl.localhost\\Ubuntu\\home\\me\\feature'

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: REPO_PATH,
    displayName: 'repo',
    badgeColor: '#000',
    addedAt: 0,
    ...overrides
  }
}

function createStore(repo: Repo, meta: Record<string, Partial<WorktreeMeta>> = {}): Store {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the listing reads only these Store members.
  return {
    getRepo: () => repo,
    getRepos: () => [repo],
    getProjects: () => [],
    getSettings: () => ({}),
    getAllWorktreeMeta: () => meta,
    getProjectHostSetups: () => [],
    getWorktreeMeta: (id: string) => meta[id],
    setWorktreeMeta: vi.fn((_target: unknown, updates: Partial<WorktreeMeta>) => updates),
    getAllWorktreeLineage: () => ({}),
    getAllWorkspaceLineage: () => ({}),
    removeWorktreeLineage: vi.fn()
  } as unknown as Store
}

async function list(store: Store, repo: Repo): Promise<DetectedWorktreeListResult> {
  const result = await listDetectedWorktreesForCapturedRepo(store, repo, () => true)
  if (!result || 'providerAbortStatus' in result) {
    throw new Error('expected a listing')
  }
  return result
}

const notify = vi.fn()

describe('worktree listing for a stopped WSL distro (E9)', () => {
  beforeEach(() => {
    mocks.listDetectedGitWorktrees.mockReset()
    mocks.runProcess.mockReset()
    notify.mockReset()
    setWslStoppedWorktreeRescanNotifier(notify)
  })

  afterEach(() => {
    setWslStoppedWorktreeRescanNotifier(null)
    _resetWslStoppedWorktreeRescansForTests()
    _resetWslBackgroundDistroGateForTests()
  })

  it('keeps the stored rows, non-authoritative, and says the distro is stopped', async () => {
    const repo = makeRepo()
    mocks.listDetectedGitWorktrees.mockRejectedValue(new WslDistroStoppedError('Ubuntu'))

    const result = await list(
      createStore(repo, { [`${repo.id}::${FEATURE_PATH}`]: { displayName: 'feature' } }),
      repo
    )

    expect(result.authoritative).toBe(false)
    expect(result.source).toBe('metadata-fallback')
    expect(result.wslDistroStopped).toEqual({ distro: 'Ubuntu', state: 'stopped' })
    expect(result.unavailableReason).toContain("WSL distro 'Ubuntu' is not running")
    // The main checkout always exists, stored or not.
    expect(result.worktrees.map((worktree) => [worktree.path, worktree.isMainWorktree])).toEqual([
      [REPO_PATH, true],
      [FEATURE_PATH, false]
    ])
  })

  it('names an unverifiable distro as such', async () => {
    const repo = makeRepo()
    mocks.listDetectedGitWorktrees.mockRejectedValue(new WslDistroUnverifiableError('Ubuntu'))

    const result = await list(createStore(repo), repo)

    expect(result.authoritative).toBe(false)
    expect(result.wslDistroStopped).toEqual({ distro: 'Ubuntu', state: 'unverifiable' })
    expect(result.worktrees.map((worktree) => worktree.path)).toEqual([REPO_PATH])
  })

  it('leaves other scan failures as they were', async () => {
    const repo = makeRepo()
    mocks.listDetectedGitWorktrees.mockRejectedValue(new Error('Command failed: wsl.exe'))

    const result = await list(createStore(repo), repo)

    expect(result.wslDistroStopped).toBeUndefined()
    expect(result.worktrees).toEqual([])
    expect(_pendingWslStoppedWorktreeRescanCount()).toBe(0)
  })

  it('re-lists once on the next settled running read, without probing', async () => {
    const repo = makeRepo()
    const store = createStore(repo)
    mocks.listDetectedGitWorktrees.mockRejectedValue(new WslDistroStoppedError('Ubuntu'))

    await list(store, repo)
    await list(store, repo)
    expect(_pendingWslStoppedWorktreeRescanCount()).toBe(1)

    noteWslDistrosRunning(['Debian'])
    await Promise.resolve()
    expect(notify).not.toHaveBeenCalled()

    noteWslDistrosRunning(['ubuntu'])
    await Promise.resolve()
    expect(notify).toHaveBeenCalledExactlyOnceWith(repo.id)
    expect(_pendingWslStoppedWorktreeRescanCount()).toBe(0)
    expect(mocks.runProcess).not.toHaveBeenCalled()

    // Drained: a later wake does not re-list again.
    noteWslDistroWoken('Ubuntu')
    expect(notify).toHaveBeenCalledOnce()
  })

  it('re-lists when a user act wakes the distro', async () => {
    const repo = makeRepo()
    mocks.listDetectedGitWorktrees.mockRejectedValue(new WslDistroStoppedError('Ubuntu'))
    await list(createStore(repo), repo)

    noteWslDistroWoken('Debian')
    expect(notify).not.toHaveBeenCalled()
    noteWslDistroWoken('Ubuntu')

    expect(notify).toHaveBeenCalledExactlyOnceWith(repo.id)
    expect(_pendingWslStoppedWorktreeRescanCount()).toBe(0)
    noteWslDistrosRunning(['Ubuntu'])
    await Promise.resolve()
    expect(notify).toHaveBeenCalledOnce()
    expect(mocks.runProcess).not.toHaveBeenCalled()
  })

  it('drops the pending re-scan once a scan succeeds', async () => {
    const repo = makeRepo()
    const store = createStore(repo)
    mocks.listDetectedGitWorktrees.mockRejectedValueOnce(new WslDistroStoppedError('Ubuntu'))
    await list(store, repo)
    mocks.listDetectedGitWorktrees.mockResolvedValueOnce({
      gitWorktrees: [
        {
          path: REPO_PATH,
          head: 'abc',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        }
      ],
      fresh: false,
      superseded: false,
      generation: 1
    })

    const result = await list(store, repo)

    expect(result.authoritative).toBe(true)
    expect(result.wslDistroStopped).toBeUndefined()
    expect(_pendingWslStoppedWorktreeRescanCount()).toBe(0)
  })

  it('lists a folder workspace on a WSL path as before', async () => {
    const repo = makeRepo({ kind: 'folder' })

    const result = await list(createStore(repo), repo)

    expect(result.authoritative).toBe(true)
    expect(result.wslDistroStopped).toBeUndefined()
    expect(mocks.listDetectedGitWorktrees).not.toHaveBeenCalled()
    expect(_pendingWslStoppedWorktreeRescanCount()).toBe(0)
  })
})

describe('Retry on a stopped WSL distro (E9)', () => {
  let originalPlatform: NodeJS.Platform

  beforeEach(() => {
    originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    mocks.listDetectedGitWorktrees.mockReset()
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    _resetWslStoppedWorktreeRescansForTests()
    _resetWslBackgroundDistroGateForTests()
  })

  it("scans as a user act on the repo's distro, so the scan may start it", async () => {
    const repo = makeRepo()
    const insideAct: boolean[] = []
    mocks.listDetectedGitWorktrees.mockImplementation(async () => {
      insideAct.push(isWslUserActFor('Ubuntu'))
      return {
        gitWorktrees: [
          {
            path: REPO_PATH,
            head: 'abc',
            branch: 'refs/heads/main',
            isBare: false,
            isMainWorktree: true
          }
        ],
        fresh: false,
        superseded: false,
        generation: 1
      }
    })

    await scanWorktreesStartingWslDistro(createStore(repo), repo.id)

    expect(insideAct).toEqual([true])
    expect(isWslUserActFor('Ubuntu')).toBe(false)
  })

  it('does nothing for a folder workspace or a repo outside WSL', async () => {
    for (const repo of [makeRepo({ kind: 'folder' }), makeRepo({ path: 'C:\\work\\repo' })]) {
      await scanWorktreesStartingWslDistro(createStore(repo), repo.id)
    }
    await scanWorktreesStartingWslDistro(createStore(makeRepo()), 'unknown-repo')

    expect(mocks.listDetectedGitWorktrees).not.toHaveBeenCalled()
  })
})
