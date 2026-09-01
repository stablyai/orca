/**
 * A WSL shell prints `/home/neil/qa-repo`; the runtime stored the same directory as the UNC path
 * Windows sees (#16628). The CLI translates, proving the caller's distro from its own UNC cwd —
 * this resolver also feeds `worktree rm`, so a tail-only match would delete another distro's copy.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronMocks = vi.hoisted(() => {
  const ipcMain = {
    on: vi.fn(() => ipcMain),
    removeListener: vi.fn(() => ipcMain),
    emit: vi.fn(() => true)
  }
  return {
    BrowserWindow: { fromId: vi.fn((): unknown => null) },
    webContents: { fromId: vi.fn((): unknown => null) },
    ipcMain,
    app: { getPath: vi.fn(() => '/tmp'), isPackaged: false }
  }
})
vi.mock('electron', () => electronMocks)

const getSshGitProviderMock = vi.hoisted(() => vi.fn())
vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: getSshGitProviderMock,
  getSshGitProviderGeneration: vi.fn(() => 0),
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE: 'unavailable',
  requireSshGitProvider: (connectionId: string) => getSshGitProviderMock(connectionId)
}))

const listWorktreesStrictMock = vi.hoisted(() => vi.fn())
vi.mock('../git/worktree', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listWorktreesStrict: listWorktreesStrictMock
}))

import { isWslUncPathForCallerLinuxPath } from '../../shared/cross-platform-path'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { OrcaRuntimeService } from './orca-runtime'

const UBUNTU = 'Ubuntu-24.04'
const DEBIAN = 'Debian'
const LINUX_REPO_PATH = '/home/neil/repo'
const LINUX_WORKTREE_PATH = '/home/neil/qa-repo'

/** The cwd the WSL launcher hands the CLI: the caller's directory, already in UNC form. */
function uncPath(distro: string, linuxPath: string): string {
  return `\\\\wsl.localhost\\${distro}${linuxPath.replace(/\//g, '\\')}`
}

type Registration = { distro: string; repoPath: string; worktreePath: string }

function registration(distro: string, spelling: (linuxPath: string) => string): Registration {
  return {
    distro,
    repoPath: spelling(LINUX_REPO_PATH),
    worktreePath: spelling(LINUX_WORKTREE_PATH)
  }
}

/** One repo per distro, so an unwanted cross-distro match shows up as the wrong resolved path. */
function makeStore(registrations: readonly Registration[]) {
  const repos = registrations.map((entry) => ({
    id: `repo-${entry.distro.toLowerCase()}`,
    path: entry.repoPath,
    displayName: entry.distro,
    badgeColor: 'blue',
    addedAt: 1
  }))
  const store = {
    getRepo: (id: string) => repos.find((repo) => repo.id === id),
    getRepos: () => repos,
    getAllWorktreeMeta: vi.fn(() => ({})),
    getWorktreeMeta: () => undefined,
    setWorktreeMeta: vi.fn(),
    removeWorktreeMeta: () => {},
    getAllWorktreeLineage: () => ({}),
    getAllWorkspaceLineage: () => ({}),
    removeWorktreeLineage: vi.fn(),
    removeWorkspaceLineage: vi.fn(),
    getGitHubCache: () => undefined as never,
    getSettings: () => ({
      workspaceDir: '/tmp/workspaces',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      branchPrefix: 'none',
      branchPrefixCustom: ''
    }),
    getProjects: () => []
  }
  return store
}

/** `git worktree list` for each registered repo: the main checkout plus one workspace. */
function scanReports(registrations: readonly Registration[]): void {
  listWorktreesStrictMock.mockImplementation(async (repoPath: string) => {
    const entry = registrations.find((candidate) => candidate.repoPath === repoPath)
    if (!entry) {
      return []
    }
    return [
      { path: entry.repoPath, head: 'abc', branch: 'main', isBare: false, isMainWorktree: true },
      {
        path: entry.worktreePath,
        head: 'def',
        branch: 'qa',
        isBare: false,
        isMainWorktree: false
      }
    ]
  })
}

function makeRuntime(registrations: readonly Registration[]): OrcaRuntimeService {
  scanReports(registrations)
  return new OrcaRuntimeService(makeStore(registrations) as never)
}

/**
 * What `resolveCallerDistroPathSelector` sends: the caller's distro comes from its own UNC cwd,
 * and the stored spelling of the one worktree that distro can mean replaces the typed path.
 * Mirrored rather than imported — `src/cli` is outside this file's tsconfig project.
 */
async function selectorTheCliWouldSend(
  runtime: OrcaRuntimeService,
  callerCwd: string,
  typedPath: string
): Promise<string> {
  const callerDistro = parseWslUncPath(callerCwd)?.distro
  if (!callerDistro) {
    return `path:${typedPath}`
  }
  const listed = await runtime.listManagedWorktrees()
  const match = listed.worktrees.find((worktree) =>
    isWslUncPathForCallerLinuxPath(worktree.path, typedPath, callerDistro)
  )
  return match ? `path:${match.path}` : `path:${typedPath}`
}

beforeEach(() => {
  getSshGitProviderMock.mockReset()
  listWorktreesStrictMock.mockReset()
})

describe('a WSL caller typing the Linux path of a UNC-stored worktree (#16628)', () => {
  it('resolves the Linux path a WSL shell prints to the UNC-stored worktree', async () => {
    const registrations = [registration(UBUNTU, (linuxPath) => uncPath(UBUNTU, linuxPath))]
    const runtime = makeRuntime(registrations)

    // The live bug: the spelling the runtime stored resolves, the one the user types does not.
    await expect(
      runtime.showManagedWorktree(`path:${uncPath(UBUNTU, LINUX_WORKTREE_PATH)}`)
    ).resolves.toMatchObject({ path: uncPath(UBUNTU, LINUX_WORKTREE_PATH) })
    await expect(runtime.showManagedWorktree(`path:${LINUX_WORKTREE_PATH}`)).rejects.toThrow(
      'selector_not_found'
    )

    const selector = await selectorTheCliWouldSend(
      runtime,
      uncPath(UBUNTU, '/home/neil'),
      LINUX_WORKTREE_PATH
    )

    await expect(runtime.showManagedWorktree(selector)).resolves.toMatchObject({
      path: uncPath(UBUNTU, LINUX_WORKTREE_PATH)
    })
  })

  it('resolves a forward-slash UNC registration from the same Linux path', async () => {
    // Windows records the same share both ways; the caller's spelling never changes.
    const forwardSlash = (linuxPath: string) => `//wsl.localhost/${UBUNTU}${linuxPath}`
    const runtime = makeRuntime([registration(UBUNTU, forwardSlash)])

    const selector = await selectorTheCliWouldSend(
      runtime,
      uncPath(UBUNTU, '/home/neil'),
      LINUX_WORKTREE_PATH
    )

    await expect(runtime.showManagedWorktree(selector)).resolves.toMatchObject({
      path: forwardSlash(LINUX_WORKTREE_PATH)
    })
  })

  it('refuses a Linux path another distro spells, instead of resolving that distro', async () => {
    const runtime = makeRuntime([registration(UBUNTU, (linuxPath) => uncPath(UBUNTU, linuxPath))])
    const selector = await selectorTheCliWouldSend(
      runtime,
      uncPath(DEBIAN, '/home/neil'),
      LINUX_WORKTREE_PATH
    )

    // Untranslated, so the runtime refuses rather than deleting Ubuntu's copy on a Debian `rm`.
    expect(selector).toBe(`path:${LINUX_WORKTREE_PATH}`)
    await expect(runtime.showManagedWorktree(selector)).rejects.toThrow('selector_not_found')
  })

  it('picks the caller-distro worktree when two distros spell the same Linux path', async () => {
    const runtime = makeRuntime([
      registration(UBUNTU, (linuxPath) => uncPath(UBUNTU, linuxPath)),
      registration(DEBIAN, (linuxPath) => uncPath(DEBIAN, linuxPath))
    ])

    const selector = await selectorTheCliWouldSend(
      runtime,
      uncPath(DEBIAN, '/home/neil'),
      LINUX_WORKTREE_PATH
    )

    await expect(runtime.showManagedWorktree(selector)).resolves.toMatchObject({
      path: uncPath(DEBIAN, LINUX_WORKTREE_PATH)
    })
  })

  it('leaves a Linux-native CLI, whose runtime stores POSIX paths, untouched', async () => {
    const posix = (linuxPath: string) => linuxPath
    const runtime = makeRuntime([registration(UBUNTU, posix)])

    const selector = await selectorTheCliWouldSend(runtime, '/home/neil', LINUX_WORKTREE_PATH)

    expect(selector).toBe(`path:${LINUX_WORKTREE_PATH}`)
    await expect(runtime.showManagedWorktree(selector)).resolves.toMatchObject({
      path: LINUX_WORKTREE_PATH
    })
  })
})
