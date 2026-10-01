import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as FsPromises from 'node:fs/promises'
import type * as WslModule from './wsl'
import type { Store } from './persistence'
import type { Repo } from '../shared/repo-types'
import { createFakeGitScript, fakeGit } from './worktree-create-spare-test-harness'

// Why separate: the other spare suites mock ./ipc/worktree-logic, so they cannot catch the request
// side (async resolver) and the create side (sync resolver) keying a WSL spare on different roots.
const mocks = vi.hoisted(() => ({
  gitExecFileAsync: vi.fn(),
  mkdir: vi.fn(async () => undefined),
  getMirrorDistro: vi.fn(),
  getWslHome: vi.fn(),
  getWslHomeAsync: vi.fn()
}))

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof FsPromises>()),
  mkdir: mocks.mkdir
}))
vi.mock('./git/runner', () => ({
  gitExecFileAsync: mocks.gitExecFileAsync,
  gitExecFileSync: vi.fn(),
  translateWslOutputPaths: (output: string) => output
}))
vi.mock('./project-runtime-git-options', () => ({
  getLocalProjectWorktreeGitOptions: () => ({}),
  getWorktreeMirrorDistro: mocks.getMirrorDistro
}))
vi.mock('./wsl', async (importOriginal) => ({
  ...(await importOriginal<typeof WslModule>()),
  getWslHome: mocks.getWslHome,
  getWslHomeAsync: mocks.getWslHomeAsync
}))

import { computeWorkspaceRoot, getWorktreePathSettings } from './ipc/worktree-logic'
import { clearGitCapabilityStateForTests } from './git/git-capability-state'
import {
  _resetSparePoolForTests,
  findSpare,
  preparationPathKey,
  spareRepoKey
} from './worktree-create-preparation-pool'
import {
  _resetSpareRequestsForTests,
  beginWorktreeCreateSpareRequest,
  requestWorktreeCreateSpare,
  SPARE_REQUEST_DEBOUNCE_MS
} from './worktree-create-preparation'

function requestSpareFor(store: Store, target: Repo, base: string): void {
  const ticket = beginWorktreeCreateSpareRequest(store, target)
  if (!ticket) {
    throw new Error('a local repo always gets a spare request ticket')
  }
  requestWorktreeCreateSpare(store, target, base, ticket)
}

const WSL_HOME = '\\\\wsl.localhost\\Ubuntu\\home\\jin'
const MIRRORED_ROOT = `${WSL_HOME}\\orca\\workspaces`
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the request reads only id, path and the absence of connectionId/kind.
const repo = { id: 'repo-1', path: `${WSL_HOME}\\src\\repo` } as Repo
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above, for a Windows-drive repo.
const windowsRepo = { id: 'repo-2', path: 'C:\\src\\repo' } as Repo
const settings = { workspaceDir: 'C:\\workspaces', nestWorkspaces: false }
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the request reads only getSettings; both Store readers it calls are mocked above.
const store = { getSettings: () => settings } as unknown as Store
const originalPlatform = process.platform

/** The create side exactly as the IPC and runtime creates build it. */
function createSideRootKey(target: Repo): string {
  const pathSettings = getWorktreePathSettings(
    target,
    settings,
    mocks.getMirrorDistro(store, target)
  )
  return preparationPathKey(computeWorkspaceRoot(target.path, pathSettings))
}

async function requestSpare(target: Repo): Promise<void> {
  requestSpareFor(store, target, 'origin/main')
  await vi.advanceTimersByTimeAsync(SPARE_REQUEST_DEBOUNCE_MS)
  await vi.waitFor(() => expect(findSpare(spareRepoKey(target.path))?.state).toBe('ready'))
}

beforeEach(() => {
  // parseWslPath only recognises UNC repo paths on win32.
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  mocks.gitExecFileAsync.mockImplementation(fakeGit(createFakeGitScript()))
  mocks.getMirrorDistro.mockReset().mockReturnValue(undefined)
  mocks.getWslHome.mockReset().mockImplementation(() => {
    throw new Error('the blocking wsl.exe home probe must not run while requesting a spare')
  })
  mocks.getWslHomeAsync.mockReset().mockResolvedValue(WSL_HOME)
  clearGitCapabilityStateForTests()
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  vi.useRealTimers()
  _resetSpareRequestsForTests()
  _resetSparePoolForTests()
})

describe('WSL spare checkouts with the real workspace-root resolver', () => {
  it('builds under the async-resolved mirror root that the sync create side reproduces', async () => {
    await requestSpare(repo)

    expect(mocks.getWslHome).not.toHaveBeenCalled()
    expect(findSpare(spareRepoKey(repo.path))?.preparedPath).toContain(MIRRORED_ROOT)
    mocks.getWslHome.mockReturnValue(WSL_HOME)
    expect(findSpare(spareRepoKey(repo.path))?.workspaceRootKey).toBe(createSideRootKey(repo))
  })

  it('mirrors a C: repo with a configured mirror distro on both sides', async () => {
    mocks.getMirrorDistro.mockReturnValue('Ubuntu')

    await requestSpare(windowsRepo)

    expect(findSpare(spareRepoKey(windowsRepo.path))?.preparedPath).toContain(MIRRORED_ROOT)
    mocks.getWslHome.mockReturnValue(WSL_HOME)
    expect(findSpare(spareRepoKey(windowsRepo.path))?.workspaceRootKey).toBe(
      createSideRootKey(windowsRepo)
    )
  })
})
