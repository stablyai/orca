import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as WslModule from './wsl'
import type { Store } from './persistence'
import type { Repo } from '../shared/repo-types'

// Why this file exists separately from worktree-create-preparation.test.ts: that suite mocks
// ./ipc/worktree-logic wholesale, so it can never catch the prepare (async resolver) / consume
// (sync resolver) key disagreement that would silently discard every prepared checkout.
const mocks = vi.hoisted(() => ({
  mkdir: vi.fn(),
  listWorktreeGraph: vi.fn(),
  prepareCheckout: vi.fn(),
  finalize: vi.fn(),
  discard: vi.fn(),
  unlock: vi.fn(),
  getWorktreeOptions: vi.fn(),
  getMirrorDistro: vi.fn(),
  getWslHome: vi.fn(),
  getWslHomeAsync: vi.fn(),
  resolveBaseRef: vi.fn()
}))

vi.mock('node:fs/promises', () => ({ mkdir: mocks.mkdir }))
vi.mock('./git/worktree', () => ({ listWorktreeGraph: mocks.listWorktreeGraph }))
vi.mock('./git/worktree-create-preparation', () => ({
  prepareWorktreeCreateCheckout: mocks.prepareCheckout,
  finalizePreparedWorktree: mocks.finalize,
  discardPreparedWorktree: mocks.discard,
  unlockPreparedWorktree: mocks.unlock
}))
vi.mock('./git/worktree-base-ref-probe', () => ({
  resolveLocalWorktreeBaseRef: mocks.resolveBaseRef
}))
vi.mock('./project-runtime-git-options', () => ({
  getLocalProjectWorktreeGitOptions: mocks.getWorktreeOptions,
  getWorktreeMirrorDistro: mocks.getMirrorDistro
}))
vi.mock('./wsl', async (importOriginal) => ({
  ...(await importOriginal<typeof WslModule>()),
  getWslHome: mocks.getWslHome,
  getWslHomeAsync: mocks.getWslHomeAsync
}))

import {
  computeWorkspaceRoot,
  computeWorktreePath,
  getWorktreePathSettings
} from './ipc/worktree-logic'
import { getWorktreeMirrorDistro } from './project-runtime-git-options'
import {
  _resetWorktreeCreatePreparationsForTests,
  consumePreparedWorktreeCreate,
  prepareWorktreeCreateForRepo
} from './worktree-create-preparation'

const WSL_HOME = '\\\\wsl.localhost\\Ubuntu\\home\\jin'
const MIRRORED_ROOT = `${WSL_HOME}\\orca\\workspaces`
const repo = { id: 'repo-1', path: `${WSL_HOME}\\src\\repo` } as Repo
const windowsRepo = { id: 'repo-2', path: 'C:\\src\\repo' } as Repo
const settings = { workspaceDir: 'C:\\workspaces', nestWorkspaces: false }
const store = { getSettings: () => settings } as unknown as Store
const originalPlatform = process.platform

/** The consume side exactly as createLocalWorktree builds it (worktree-remote.ts). */
function consumeSideRoots(target: Repo): { workspaceRoot: string; worktreePath: string } {
  const pathSettings = getWorktreePathSettings(
    target,
    settings,
    getWorktreeMirrorDistro(store as never, target)
  )
  return {
    workspaceRoot: computeWorkspaceRoot(target.path, pathSettings),
    worktreePath: computeWorktreePath('feature', target.path, pathSettings)
  }
}

beforeEach(() => {
  // parseWslPath only recognises UNC repo paths on win32, so pin the platform rather than
  // skipping the case everywhere else.
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  mocks.mkdir.mockReset().mockResolvedValue(undefined)
  mocks.listWorktreeGraph.mockReset().mockResolvedValue([])
  mocks.prepareCheckout.mockReset().mockResolvedValue(undefined)
  mocks.finalize.mockReset().mockResolvedValue({ path: 'created' })
  mocks.discard.mockReset().mockResolvedValue(undefined)
  mocks.unlock.mockReset().mockResolvedValue(undefined)
  mocks.getWorktreeOptions.mockReset().mockReturnValue({})
  mocks.getMirrorDistro.mockReset().mockReturnValue(undefined)
  mocks.getWslHome.mockReset().mockImplementation(() => {
    throw new Error('the blocking wsl.exe home probe must not run while preparing')
  })
  mocks.getWslHomeAsync.mockReset().mockResolvedValue(WSL_HOME)
  mocks.resolveBaseRef
    .mockReset()
    .mockImplementation(async (_repoPath: string, baseRef: string) => `refs/remotes/${baseRef}`)
})

afterEach(async () => {
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  await _resetWorktreeCreatePreparationsForTests()
})

describe('worktree create preparation with the real WSL workspace-root resolver', () => {
  it('prepares under the async-resolved mirror root that the sync consume side reproduces', async () => {
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')

    expect(mocks.getWslHome).not.toHaveBeenCalled()
    expect(mocks.prepareCheckout).toHaveBeenCalledTimes(1)
    expect(mocks.prepareCheckout.mock.calls[0]?.[1]).toContain(MIRRORED_ROOT)

    // createLocalWorktree still resolves the root synchronously, off the cache the probe warmed.
    mocks.getWslHome.mockReturnValue(WSL_HOME)
    const result = await consumePreparedWorktreeCreate({
      repoPath: repo.path,
      ...consumeSideRoots(repo),
      branch: 'feature',
      baseBranch: 'origin/main'
    })

    expect(result).not.toBeNull()
    expect(mocks.finalize).toHaveBeenCalledTimes(1)
    expect(mocks.discard).not.toHaveBeenCalled()
  })

  it('mirrors a C: repo with a configured mirror distro on both sides', async () => {
    mocks.getMirrorDistro.mockReturnValue('Ubuntu')

    await prepareWorktreeCreateForRepo(store, windowsRepo, 'origin/main')

    expect(mocks.prepareCheckout.mock.calls[0]?.[1]).toContain(MIRRORED_ROOT)

    mocks.getWslHome.mockReturnValue(WSL_HOME)
    const result = await consumePreparedWorktreeCreate({
      repoPath: windowsRepo.path,
      ...consumeSideRoots(windowsRepo),
      branch: 'feature',
      baseBranch: 'origin/main'
    })

    expect(result).not.toBeNull()
    expect(mocks.discard).not.toHaveBeenCalled()
  })

  it('discards nothing and falls back when the probe fails during preparation', async () => {
    mocks.getWslHomeAsync.mockResolvedValue(null)

    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')

    // No mirror home -> the configured desktop root, matching what the sync resolver returns
    // for the same failed probe.
    expect(mocks.prepareCheckout.mock.calls[0]?.[1]).toContain('C:\\workspaces')
  })
})
