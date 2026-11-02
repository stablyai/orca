import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../shared/repo-types'

const mocks = vi.hoisted(() => ({
  resolveLocalGitUsernameDetailed: vi.fn(),
  readWslDistroRunningState: vi.fn()
}))

vi.mock('./git/git-username', () => ({
  resolveLocalGitUsernameDetailed: mocks.resolveLocalGitUsernameDetailed
}))
vi.mock('./wsl-background-distro-gate', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readWslDistroRunningState: mocks.readWslDistroRunningState
}))

const {
  enrichRepoGitUsernames,
  flushRepoGitUsernameEnrichmentForTests,
  resetRepoGitUsernameEnrichmentForTests
} = await import('./repo-git-username-enrichment')
const { blockedWslDistroForPath } = await import('./wsl/wsl-unc-access-gate')
const { runAsWslUserAct } = await import('./wsl/wsl-user-act-scope')

const repo: Repo = {
  id: 'r1',
  path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo',
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 1
}

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

describe('repo username enrichment inside a WSL user act (E9)', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    mocks.resolveLocalGitUsernameDetailed.mockReset()
    mocks.readWslDistroRunningState.mockReset().mockResolvedValue('stopped')
    resetRepoGitUsernameEnrichmentForTests()
  })

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it('does not lend the act to its shared pass, whose Git on the stopped distro stays held', async () => {
    const store = { getRepos: () => [repo], setResolvedRepoGitUsername: vi.fn(() => true) }

    await runAsWslUserAct('Ubuntu', async () => {
      // The act's own work is admitted, without a running read.
      await expect(blockedWslDistroForPath(repo.path)).resolves.toBeNull()
      enrichRepoGitUsernames(store)
      await flushRepoGitUsernameEnrichmentForTests()
    })

    expect(mocks.resolveLocalGitUsernameDetailed).not.toHaveBeenCalled()
    expect(store.setResolvedRepoGitUsername).not.toHaveBeenCalled()
  })
})
