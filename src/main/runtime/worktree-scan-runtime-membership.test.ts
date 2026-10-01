// A sustained 1 Hz fleet poll (mobile `worktree.ps`, CLI selectors) over real repos. A repo whose
// membership model reads Git's files is answered from the model: one `git worktree list` in total,
// no rows in the runtime's 30 s cache, and still fresh. Repos the model leaves to Git, and SSH
// repos, keep that cache.
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Runner from '../git/runner'

vi.mock('electron', () => {
  const ipcMain = { on: vi.fn(), removeListener: vi.fn(), emit: vi.fn(() => true) }
  return {
    BrowserWindow: { fromId: vi.fn((): unknown => null) },
    webContents: { fromId: vi.fn((): unknown => null) },
    ipcMain,
    app: { getPath: vi.fn(() => '/tmp'), isPackaged: false }
  }
})

const getSshGitProviderMock = vi.hoisted(() => vi.fn())
vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: getSshGitProviderMock,
  getSshGitProviderGeneration: vi.fn(() => 0),
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE: 'unavailable',
  requireSshGitProvider: (connectionId: string) => getSshGitProviderMock(connectionId)
}))

const worktreeListCwds = vi.hoisted((): string[] => [])
vi.mock('../git/runner', async (importOriginal) => {
  const actual = await importOriginal<typeof Runner>()
  return {
    ...actual,
    gitExecFileAsync: (args: string[], options: Parameters<typeof actual.gitExecFileAsync>[1]) => {
      if (args[0] === 'worktree' && args[1] === 'list') {
        worktreeListCwds.push(String(options?.cwd))
      }
      return actual.gitExecFileAsync(args, options)
    }
  }
})

import { OrcaRuntimeService } from './orca-runtime'
import { _resetWorktreeMembershipModelsForTests } from '../git/worktree-membership/worktree-membership-store'

const execFileAsync = promisify(execFile)

let scratchDir = ''

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd })
  return stdout.trim()
}

async function commitIn(worktreePath: string, name: string): Promise<string> {
  await writeFile(join(worktreePath, `${name}.txt`), `${name}\n`)
  await git(['add', '-A'], worktreePath)
  await git(
    ['-c', 'user.email=r@example.invalid', '-c', 'user.name=R', 'commit', '-qm', name],
    worktreePath
  )
  return git(['rev-parse', 'HEAD'], worktreePath)
}

async function makeRepo(name: string): Promise<{ repoPath: string; linked: string }> {
  const repoPath = join(scratchDir, name)
  await mkdir(repoPath)
  await git(['init', '-q', '-b', 'main'], repoPath)
  await commitIn(repoPath, 'seed')
  const linked = join(scratchDir, `${name}-linked`)
  await git(['worktree', 'add', '-q', linked, '-b', `${name}-linked`], repoPath)
  return { repoPath, linked }
}

function makeStore(repos: { id: string; path: string; connectionId?: string }[]) {
  const metaById: Record<string, Record<string, unknown>> = {}
  const store = {
    getRepo: (id: string) => store.getRepos().find((repo) => repo.id === id),
    getRepos: () =>
      repos.map((repo) => ({ ...repo, displayName: repo.id, badgeColor: 'blue', addedAt: 1 })),
    getAllWorktreeMeta: () => metaById,
    getWorktreeMeta: (id: string) => metaById[id],
    setWorktreeMeta: (id: string, meta: Record<string, unknown>) => {
      metaById[id] = { ...metaById[id], ...meta }
      return metaById[id]
    },
    removeWorktreeMeta: () => {},
    getAllWorktreeLineage: () => ({}),
    getAllWorkspaceLineage: () => ({}),
    removeWorktreeLineage: vi.fn(),
    removeWorkspaceLineage: vi.fn(),
    getGitHubCache: () => undefined,
    getSettings: () => ({
      workspaceDir: join(scratchDir, 'workspaces'),
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      branchPrefix: 'none',
      branchPrefixCustom: ''
    }),
    getProjects: () => []
  }
  return store
}

type RuntimeInternals = {
  listResolvedWorktrees: () => Promise<{ id: string; head: string; branch: string }[]>
  worktreeScanCache: Map<string, unknown>
}

beforeEach(async () => {
  scratchDir = await realpath(await mkdtemp(join(tmpdir(), 'orca-runtime-membership-')))
  worktreeListCwds.length = 0
  getSshGitProviderMock.mockReset()
  _resetWorktreeMembershipModelsForTests()
})

afterEach(async () => {
  vi.restoreAllMocks()
  _resetWorktreeMembershipModelsForTests()
  await rm(scratchDir, { recursive: true, force: true })
})

describe('runtime fleet scan over membership models', () => {
  it('answers a 1 Hz poll without re-listing, keeps row caches only where Git answers', async () => {
    const files = await makeRepo('files')
    const gitOnly = await makeRepo('git-only')
    // An include is a layout only Git resolves, so the model leaves this repo to Git.
    await git(['config', 'include.path', join(scratchDir, 'absent.gitconfig')], gitOnly.repoPath)
    const sshPath = '/remote/app'
    getSshGitProviderMock.mockReturnValue({
      listWorktrees: vi.fn(async () => [
        { path: sshPath, head: 'abc', branch: 'main', isBare: false, isMainWorktree: true }
      ])
    })
    const store = makeStore([
      { id: 'files', path: files.repoPath },
      { id: 'git-only', path: gitOnly.repoPath },
      { id: 'ssh', path: sshPath, connectionId: 'remote-1' }
    ])
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: makeStore returns the repo, meta and settings reads a fleet scan makes; the rest of Store is unreached.
    const service = new OrcaRuntimeService(store as never)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: both members exist on the runtime; they are protected, not absent.
    const runtime = service as unknown as RuntimeInternals
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)

    let expectedHead = await git(['rev-parse', 'HEAD'], files.linked)
    for (let second = 0; second < 60; second++) {
      if (second === 30) {
        // An external commit no event reported: the next poll must still see it.
        expectedHead = await commitIn(files.linked, 'unreported')
      }
      const worktrees = await runtime.listResolvedWorktrees()
      expect(worktrees.find((row) => row.id === `files::${files.linked}`)?.head).toBe(expectedHead)
      now += 1_000
    }

    expect(worktreeListCwds.filter((cwd) => cwd === files.repoPath)).toHaveLength(1)
    expect(worktreeListCwds.filter((cwd) => cwd === gitOnly.repoPath)).toHaveLength(1)
    expect(runtime.worktreeScanCache.has('files\0local')).toBe(false)
    expect(runtime.worktreeScanCache.has('git-only\0local')).toBe(true)
    expect(runtime.worktreeScanCache.has('ssh\0ssh:remote-1')).toBe(true)
  }, 60_000)

  it('answers a healthy local repo fresh on every snapshot while many SSH repos stall', async () => {
    const local = await makeRepo('local')
    // A half-open SSH host: every remote listing hangs.
    getSshGitProviderMock.mockReturnValue({ listWorktrees: () => new Promise(() => {}) })
    const stalled = Array.from({ length: 9 }, (_unused, index) => ({
      id: `ssh-${index}`,
      path: `/remote/app-${index}`,
      connectionId: 'remote-1'
    }))
    const store = makeStore([...stalled, { id: 'local', path: local.repoPath }])
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: makeStore returns the repo, meta and settings reads a fleet scan makes; the rest of Store is unreached.
    const service = new OrcaRuntimeService(store as never)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: both members exist on the runtime; they are protected, not absent.
    const runtime = service as unknown as RuntimeInternals
    // Real time plus a skip per snapshot: the stalled repos' budgets must really run out.
    const realNow = Date.now.bind(Date)
    let skipped = 0
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + skipped)

    for (const name of ['first', 'second']) {
      // Created from a terminal: only a fresh read of the repo knows it.
      await git(['worktree', 'add', '-q', join(scratchDir, name), '-b', name], local.repoPath)
      skipped += 1_000
      const worktrees = await runtime.listResolvedWorktrees()
      const created = worktrees.find((row) => row.id === `local::${join(scratchDir, name)}`)
      expect(created?.branch).toBe(`refs/heads/${name}`)
    }
  }, 30_000)
})
