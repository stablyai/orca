import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as FsPromises from 'node:fs/promises'
import type * as GitRepo from '../git/repo'
import type { Repo } from '../../shared/repo-types'

// Why: the watch must stay one stat per folder project per tick — counting the real
// calls is what keeps a directory-listing fan-out from creeping back in.
const { statCalls, readdirSpy, gitProbes } = vi.hoisted(() => ({
  statCalls: [] as string[],
  readdirSpy: vi.fn(),
  // Why: the rejected-marker cache exists to stop git respawning every tick; counting the
  // real probes is the only way that guarantee stays true.
  gitProbes: [] as string[]
}))

vi.mock('../git/repo', async (importOriginal) => {
  const actual = await importOriginal<typeof GitRepo>()
  return {
    ...actual,
    isGitRepo: (path: string) => {
      gitProbes.push(path)
      return actual.isGitRepo(path)
    }
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    stat: (path: string, ...rest: never[]) => {
      statCalls.push(path)
      return actual.stat(path, ...rest)
    },
    readdir: (path: string, ...rest: never[]) => {
      readdirSpy(path)
      return actual.readdir(path, ...rest)
    }
  }
})

vi.mock('./worktree-remote', () => ({
  notifyWorktreesChanged: vi.fn()
}))
vi.mock('./repos/repos-changed-notification', () => ({
  notifyReposChanged: vi.fn()
}))
vi.mock('./registered-worktree-roots-cache', () => ({
  invalidateAuthorizedRootsCache: vi.fn()
}))
vi.mock('../worktree-root-preparation', () => ({
  prepareLocalWorktreeRootForRepo: vi.fn(async () => {})
}))

import { notifyWorktreesChanged } from './worktree-remote'
import { notifyReposChanged } from './repos/repos-changed-notification'
import { invalidateAuthorizedRootsCache } from './registered-worktree-roots-cache'
import { prepareLocalWorktreeRootForRepo } from '../worktree-root-preparation'
import { notifyMainWindowBecameVisible } from '../window/main-window-visibility'
import {
  startFolderRepoGitUpgradeWatch,
  stopFolderRepoGitUpgradeWatch
} from './folder-repo-git-upgrade'
import { wakeFolderRepoGitUpgradeWatch } from './folder-repo-git-upgrade-wake'

type TestWindow = {
  destroyed: boolean
  visible: boolean
  isDestroyed: () => boolean
  isVisible: () => boolean
  isMinimized: () => boolean
  webContents: { send: ReturnType<typeof vi.fn> }
}

function makeWindow(): TestWindow {
  const window: TestWindow = {
    destroyed: false,
    visible: true,
    isDestroyed: () => window.destroyed,
    isVisible: () => window.visible,
    isMinimized: () => false,
    webContents: { send: vi.fn() }
  }
  return window
}

function makeRepo(overrides: Partial<Repo> & Pick<Repo, 'id' | 'path'>): Repo {
  return {
    displayName: overrides.id,
    badgeColor: '#000000',
    addedAt: Date.now(),
    kind: 'folder',
    ...overrides
  } as Repo
}

function makeStore(
  repos: Repo[],
  worktreeMeta: Record<string, unknown> = {}
): {
  getRepos: () => Repo[]
  getRepo: ReturnType<typeof vi.fn>
  updateRepo: ReturnType<typeof vi.fn>
  getAllWorktreeMeta: () => Record<string, unknown>
  getSettings: () => Record<string, never>
} {
  return {
    getAllWorktreeMeta: () => worktreeMeta,
    getRepos: () => repos,
    getRepo: vi.fn((id: string) => repos.find((repo) => repo.id === id)),
    updateRepo: vi.fn((id: string, updates: Partial<Repo>) => {
      const repo = repos.find((candidate) => candidate.id === id)
      if (!repo) {
        return null
      }
      Object.assign(repo, updates)
      return repo
    }),
    getSettings: () => ({})
  }
}

const POLL_MS = 25
const IDLE_POLL_MS = 250

function gitInit(repoPath: string): void {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoPath, stdio: 'ignore' })
}

describe('folder repo git upgrade watch', () => {
  // Why: `realpathSync` because macOS TMPDIR is itself a symlink; `symlinkedRoot` is an
  // explicit link so the spelling-mismatch test runs the same way on Linux and Windows CI.
  let root: string
  let symlinkedRoot: string

  beforeEach(async () => {
    vi.clearAllMocks()
    root = realpathSync(await mkdtemp(join(tmpdir(), 'folder-repo-upgrade-')))
    symlinkedRoot = `${root}-link`
    await symlink(root, symlinkedRoot, 'dir')
    statCalls.length = 0
    gitProbes.length = 0
  })

  afterEach(async () => {
    stopFolderRepoGitUpgradeWatch()
    await rm(symlinkedRoot, { force: true })
    await rm(root, { recursive: true, force: true })
  })

  // Real timers: the tick awaits real filesystem stats, which fake timers cannot flush.
  async function tick(times = 1): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * times + POLL_MS))
  }

  /** Why: a tick that spawns git can outrun a fixed wait on a loaded machine. */
  async function waitForStats(count: number): Promise<void> {
    const deadline = Date.now() + 5_000
    while (statCalls.length < count && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    }
  }

  it('upgrades a local folder repo once an external git init creates .git', async () => {
    const repoPath = join(root, 'my-project')
    await mkdir(repoPath)
    const store = makeStore([makeRepo({ id: 'folder-repo', path: repoPath })])
    const window = makeWindow()
    startFolderRepoGitUpgradeWatch(store as never, window as never, {
      pollIntervalMs: POLL_MS,
      idlePollIntervalMs: IDLE_POLL_MS
    })
    await tick()
    expect(store.updateRepo).not.toHaveBeenCalled()

    gitInit(repoPath)
    await tick()

    expect(store.updateRepo).toHaveBeenCalledWith('folder-repo', {
      kind: 'git',
      externalWorktreeVisibility: 'hide'
    })
    expect(prepareLocalWorktreeRootForRepo).toHaveBeenCalledTimes(1)
    expect(invalidateAuthorizedRootsCache).toHaveBeenCalledTimes(1)
    // Why: the shared notifier is what also reaches paired clients (#11994).
    expect(notifyReposChanged).toHaveBeenCalledWith(window)
    expect(notifyWorktreesChanged).toHaveBeenCalledWith(window, 'folder-repo')
  })

  it("keeps external worktrees visible when the stored path is not git's own root", async () => {
    // Why: a symlinked parent makes git report a different toplevel; hiding external
    // worktrees there would hide the project's only workspace (found in Electron QA).
    const repoPath = join(symlinkedRoot, 'symlinked-project')
    await mkdir(repoPath)
    gitInit(repoPath)
    const store = makeStore([makeRepo({ id: 'folder-repo', path: repoPath })])

    startFolderRepoGitUpgradeWatch(store as never, makeWindow() as never, {
      pollIntervalMs: POLL_MS,
      idlePollIntervalMs: IDLE_POLL_MS
    })
    await tick()

    expect(store.updateRepo).toHaveBeenCalledWith('folder-repo', { kind: 'git' })
  })

  it('refuses a project that has folder workspaces the git listing would drop', async () => {
    // Why: the git listing branch prunes every lineage id under the repo that `git worktree
    // list` does not report, which is all of them — the workspaces would be destroyed.
    const repoPath = join(root, 'notebook')
    await mkdir(repoPath)
    gitInit(repoPath)
    const store = makeStore([makeRepo({ id: 'folder-repo', path: repoPath })], {
      [`folder-repo::${repoPath}`]: { displayName: 'notebook' },
      [`folder-repo::${repoPath}::workspace:11111111-1111-1111-1111-111111111111`]: {
        displayName: 'draft'
      }
    })

    startFolderRepoGitUpgradeWatch(store as never, makeWindow() as never, {
      pollIntervalMs: POLL_MS,
      idlePollIntervalMs: IDLE_POLL_MS
    })
    await tick(2)

    expect(store.updateRepo).not.toHaveBeenCalled()
  })

  it('retries after the last extra folder workspace is removed', async () => {
    const repoPath = join(root, 'notebook-cleanup')
    await mkdir(repoPath)
    gitInit(repoPath)
    const workspaceId = `folder-repo::${repoPath}::workspace:11111111-1111-1111-1111-111111111111`
    const worktreeMeta: Record<string, unknown> = {
      [`folder-repo::${repoPath}`]: { displayName: 'notebook-cleanup' },
      [workspaceId]: { displayName: 'draft' }
    }
    const store = makeStore([makeRepo({ id: 'folder-repo', path: repoPath })], worktreeMeta)

    startFolderRepoGitUpgradeWatch(store as never, makeWindow() as never, {
      pollIntervalMs: POLL_MS,
      idlePollIntervalMs: IDLE_POLL_MS
    })
    await tick(2)
    expect(store.updateRepo).not.toHaveBeenCalled()

    delete worktreeMeta[workspaceId]
    await tick(2)

    expect(store.updateRepo).toHaveBeenCalledWith(
      'folder-repo',
      expect.objectContaining({ kind: 'git' })
    )
  })

  it('still upgrades a project that only has its root workspace', async () => {
    const repoPath = join(root, 'solo')
    await mkdir(repoPath)
    gitInit(repoPath)
    const store = makeStore([makeRepo({ id: 'folder-repo', path: repoPath })], {
      [`folder-repo::${repoPath}`]: { displayName: 'solo' }
    })

    startFolderRepoGitUpgradeWatch(store as never, makeWindow() as never, {
      pollIntervalMs: POLL_MS,
      idlePollIntervalMs: IDLE_POLL_MS
    })
    await tick(2)

    expect(store.updateRepo).toHaveBeenCalledWith(
      'folder-repo',
      expect.objectContaining({ kind: 'git' })
    )
  })

  it('refuses a folder that is inside another repo rather than its own root', async () => {
    // Why: git accepts any path inside a work tree, so a stray marker in a subdirectory
    // would otherwise flip a project whose path is not a repository root.
    const outer = join(root, 'outer')
    await mkdir(outer)
    gitInit(outer)
    const inner = join(outer, 'sub')
    await mkdir(join(inner, '.git'), { recursive: true })
    const store = makeStore([makeRepo({ id: 'folder-repo', path: inner })])

    startFolderRepoGitUpgradeWatch(store as never, makeWindow() as never, {
      pollIntervalMs: POLL_MS,
      idlePollIntervalMs: IDLE_POLL_MS
    })
    await tick(2)

    expect(store.updateRepo).not.toHaveBeenCalled()
  })

  it('probes git once for a marker it rejects instead of every tick', async () => {
    const repoPath = join(root, 'stray-marker')
    await mkdir(repoPath)
    await writeFile(join(repoPath, '.git'), 'not a gitdir pointer\n')
    const store = makeStore([makeRepo({ id: 'folder-repo', path: repoPath })])

    startFolderRepoGitUpgradeWatch(store as never, makeWindow() as never, {
      pollIntervalMs: POLL_MS,
      idlePollIntervalMs: IDLE_POLL_MS
    })
    await waitForStats(4)

    // The marker is still stat'd every tick; git is not re-run for it.
    expect(statCalls.length).toBeGreaterThanOrEqual(4)
    expect(gitProbes).toHaveLength(1)
  })

  it('re-probes once the rejected marker itself changes', async () => {
    const repoPath = join(root, 'late-init')
    await mkdir(repoPath)
    await writeFile(join(repoPath, '.git'), 'not a gitdir pointer\n')
    const store = makeStore([makeRepo({ id: 'folder-repo', path: repoPath })])

    startFolderRepoGitUpgradeWatch(store as never, makeWindow() as never, {
      pollIntervalMs: POLL_MS,
      idlePollIntervalMs: IDLE_POLL_MS
    })
    await tick(2)
    expect(store.updateRepo).not.toHaveBeenCalled()

    await rm(join(repoPath, '.git'), { force: true })
    gitInit(repoPath)
    await tick(2)

    expect(store.updateRepo).toHaveBeenCalledWith(
      'folder-repo',
      expect.objectContaining({ kind: 'git' })
    )
  })

  it('stops probing while the window is destroyed and resumes on re-attach', async () => {
    const repoPath = join(root, 'my-project')
    await mkdir(repoPath)
    const store = makeStore([makeRepo({ id: 'folder-repo', path: repoPath })])
    const window = makeWindow()

    startFolderRepoGitUpgradeWatch(store as never, window as never, {
      pollIntervalMs: POLL_MS,
      idlePollIntervalMs: IDLE_POLL_MS
    })
    await tick()

    window.destroyed = true
    gitInit(repoPath)
    statCalls.length = 0
    await tick(3)
    expect(store.updateRepo).not.toHaveBeenCalled()
    expect(statCalls).toHaveLength(0)

    // A re-attached window replaces the destroyed one on the running watch.
    const nextWindow = makeWindow()
    startFolderRepoGitUpgradeWatch(store as never, nextWindow as never, {
      pollIntervalMs: POLL_MS,
      idlePollIntervalMs: IDLE_POLL_MS
    })
    await tick(2)

    expect(store.updateRepo).toHaveBeenCalledWith(
      'folder-repo',
      expect.objectContaining({ kind: 'git' })
    )
    expect(notifyReposChanged).toHaveBeenCalledWith(nextWindow)
  })

  it('ignores a .git entry git itself does not accept as a repository', async () => {
    const repoPath = join(root, 'stray-marker')
    await mkdir(repoPath)
    await writeFile(join(repoPath, '.git'), 'not a gitdir pointer\n')
    const store = makeStore([makeRepo({ id: 'folder-repo', path: repoPath })])

    startFolderRepoGitUpgradeWatch(store as never, makeWindow() as never, {
      pollIntervalMs: POLL_MS,
      idlePollIntervalMs: IDLE_POLL_MS
    })
    await tick(2)

    expect(store.updateRepo).not.toHaveBeenCalled()
  })

  it('upgrades only the folder repo that gained a .git marker', async () => {
    const pathA = join(root, 'project-a')
    const pathB = join(root, 'project-b')
    await mkdir(pathA)
    await mkdir(pathB)
    const store = makeStore([
      makeRepo({ id: 'repo-a', path: pathA }),
      makeRepo({ id: 'repo-b', path: pathB })
    ])

    startFolderRepoGitUpgradeWatch(store as never, makeWindow() as never, {
      pollIntervalMs: POLL_MS,
      idlePollIntervalMs: IDLE_POLL_MS
    })
    gitInit(pathA)
    await tick()

    expect(store.updateRepo).toHaveBeenCalledTimes(1)
    expect(store.updateRepo).toHaveBeenCalledWith(
      'repo-a',
      expect.objectContaining({ kind: 'git' })
    )
  })

  it('never upgrades again once the repo is already git', async () => {
    const repoPath = join(root, 'my-project')
    await mkdir(repoPath)
    gitInit(repoPath)
    const store = makeStore([makeRepo({ id: 'folder-repo', path: repoPath })])

    startFolderRepoGitUpgradeWatch(store as never, makeWindow() as never, {
      pollIntervalMs: POLL_MS,
      idlePollIntervalMs: IDLE_POLL_MS
    })
    await tick(3)

    expect(store.updateRepo).toHaveBeenCalledTimes(1)
  })

  it('skips remote and WSL folder repos a local stat cannot answer for', async () => {
    const sshPath = join(root, 'ssh-project')
    await mkdir(sshPath)
    gitInit(sshPath)
    const store = makeStore([
      makeRepo({ id: 'ssh-repo', path: sshPath, connectionId: 'conn-1' }),
      makeRepo({ id: 'wsl-repo', path: '\\\\wsl$\\Ubuntu\\home\\user\\project' }),
      makeRepo({ id: 'runtime-repo', path: sshPath, executionHostId: 'runtime:dev' })
    ])

    startFolderRepoGitUpgradeWatch(store as never, makeWindow() as never, {
      pollIntervalMs: POLL_MS,
      idlePollIntervalMs: IDLE_POLL_MS
    })
    await tick(2)

    expect(store.updateRepo).not.toHaveBeenCalled()
  })

  it('backs off to the idle interval and stats nothing when no folder project exists', async () => {
    let listCalls = 0
    const store = makeStore([makeRepo({ id: 'git-repo', path: join(root, 'g'), kind: 'git' })])
    const repos = store.getRepos()
    store.getRepos = () => {
      listCalls++
      return repos
    }

    startFolderRepoGitUpgradeWatch(store as never, makeWindow() as never, {
      pollIntervalMs: POLL_MS,
      idlePollIntervalMs: IDLE_POLL_MS
    })
    await tick(5)

    // Why: at the fast interval this window would tick ~6 times; on the idle interval it
    // ticks once. Anything above 2 means the backoff was skipped.
    expect(listCalls).toBeGreaterThanOrEqual(1)
    expect(listCalls).toBeLessThanOrEqual(2)
    expect(store.getRepo).not.toHaveBeenCalled()
    expect(statCalls).toHaveLength(0)
  })

  it('picks up a folder project added after the watch started, without a restart', async () => {
    const repos = [makeRepo({ id: 'git-repo', path: join(root, 'g'), kind: 'git' })]
    const store = makeStore(repos)

    startFolderRepoGitUpgradeWatch(store as never, makeWindow() as never, {
      pollIntervalMs: POLL_MS,
      idlePollIntervalMs: IDLE_POLL_MS
    })
    await tick()
    const repoPath = join(root, 'late-project')
    await mkdir(repoPath)
    gitInit(repoPath)
    repos.push(makeRepo({ id: 'late-repo', path: repoPath }))
    wakeFolderRepoGitUpgradeWatch()
    await tick(2)

    expect(store.updateRepo).toHaveBeenCalledWith(
      'late-repo',
      expect.objectContaining({ kind: 'git' })
    )
  })

  it('parks while the window is hidden and resumes when it becomes visible', async () => {
    const repoPath = join(root, 'my-project')
    await mkdir(repoPath)
    const store = makeStore([makeRepo({ id: 'folder-repo', path: repoPath })])
    const window = makeWindow()

    startFolderRepoGitUpgradeWatch(store as never, window as never, {
      pollIntervalMs: POLL_MS,
      idlePollIntervalMs: IDLE_POLL_MS
    })
    await tick()

    window.visible = false
    gitInit(repoPath)
    statCalls.length = 0
    await tick(3)
    expect(store.updateRepo).not.toHaveBeenCalled()
    expect(statCalls).toHaveLength(0)

    window.visible = true
    notifyMainWindowBecameVisible()
    await tick()

    expect(store.updateRepo).toHaveBeenCalledWith(
      'folder-repo',
      expect.objectContaining({
        kind: 'git'
      })
    )
  })

  it('does not notify when the repo disappears between the marker check and the update', async () => {
    const repoPath = join(root, 'my-project')
    await mkdir(repoPath)
    gitInit(repoPath)
    const repos = [makeRepo({ id: 'folder-repo', path: repoPath })]
    const store = makeStore(repos)
    store.updateRepo.mockReturnValue(null)
    const window = makeWindow()
    startFolderRepoGitUpgradeWatch(store as never, window as never, {
      pollIntervalMs: POLL_MS,
      idlePollIntervalMs: IDLE_POLL_MS
    })
    await tick()

    expect(store.updateRepo).toHaveBeenCalled()
    expect(notifyReposChanged).not.toHaveBeenCalled()
    expect(notifyWorktreesChanged).not.toHaveBeenCalled()
  })

  it('costs one .git stat per folder project per tick and never lists a directory', async () => {
    const paths = ['a', 'b', 'c'].map((name) => join(root, name))
    for (const repoPath of paths) {
      await mkdir(repoPath)
      // Sibling dirs a parent-directory scan would have to stat on every tick.
      await mkdir(join(repoPath, 'nested'))
    }
    const store = makeStore(
      paths.map((repoPath, index) => makeRepo({ id: `repo-${index}`, path: repoPath }))
    )

    startFolderRepoGitUpgradeWatch(store as never, makeWindow() as never, {
      pollIntervalMs: POLL_MS,
      idlePollIntervalMs: IDLE_POLL_MS
    })
    statCalls.length = 0
    await tick(4)

    // Why: assert the shape, not the tick count — wall-clock slack decides how many ticks
    // land, but every project must be stat'd the same number of times (a per-tick
    // multiplication breaks that) and a directory listing must never appear.
    const perPath = paths.map(
      (repoPath) => statCalls.filter((call) => call === join(repoPath, '.git')).length
    )
    expect(Math.min(...perPath)).toBeGreaterThanOrEqual(2)
    expect(Math.max(...perPath) - Math.min(...perPath)).toBeLessThanOrEqual(1)
    expect(new Set(statCalls)).toEqual(new Set(paths.map((repoPath) => join(repoPath, '.git'))))
    expect(readdirSpy).not.toHaveBeenCalled()
  })

  it('stops polling after the watch is disposed', async () => {
    const repoPath = join(root, 'my-project')
    await mkdir(repoPath)
    const store = makeStore([makeRepo({ id: 'folder-repo', path: repoPath })])

    startFolderRepoGitUpgradeWatch(store as never, makeWindow() as never, {
      pollIntervalMs: POLL_MS,
      idlePollIntervalMs: IDLE_POLL_MS
    })
    await tick()
    stopFolderRepoGitUpgradeWatch()

    gitInit(repoPath)
    statCalls.length = 0
    await tick(3)

    expect(store.updateRepo).not.toHaveBeenCalled()
    expect(statCalls).toHaveLength(0)
  })
})
