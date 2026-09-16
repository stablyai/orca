/**
 * `repos:isGitAvailable` gates the create dialog's Git option. Only a spawn that never started may
 * answer `false`; everything else rejects so the renderer's existing `unknown` branch is reachable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({ gitExecFileAsyncMock: vi.fn() }))

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../../git/runner', () => ({ gitExecFileAsync: gitExecFileAsyncMock }))
vi.mock('../../repo-icon-autodetect', () => ({
  detectRepoIconAndUpstream: vi.fn(async () => ({}))
}))
vi.mock('../../worktree-root-preparation', () => ({
  prepareLocalWorktreeRootForRepo: vi.fn(async () => {})
}))
vi.mock('../registered-worktree-roots-cache', () => ({
  invalidateAuthorizedRootsCache: vi.fn()
}))
vi.mock('./repo-added-telemetry', () => ({ emitRepoAdded: vi.fn() }))
vi.mock('./repos-changed-notification', () => ({ notifyReposChanged: vi.fn() }))
vi.mock('./local-repo-registration', () => ({ addLocalRepoFromPath: vi.fn() }))
vi.mock('./remote-repo-registration', () => ({ addRemoteRepoFromPath: vi.fn() }))
vi.mock('./remote-repo-creation', () => ({ createRemoteRepo: vi.fn() }))

import { probeLocalGitAvailability } from './repo-creation-handlers'

describe('repos:isGitAvailable', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('answers true when git reports its version', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: 'git version 2.25.1\n', stderr: '' })
    await expect(probeLocalGitAvailability()).resolves.toBe(true)
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['--version'], {
      cwd: process.cwd(),
      timeout: 1500
    })
  })

  it('answers false only when the spawn itself found no binary', async () => {
    gitExecFileAsyncMock.mockRejectedValue(
      Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT', syscall: 'spawn git' })
    )
    await expect(probeLocalGitAvailability()).resolves.toBe(false)
  })

  it('rejects an ENOENT when the working directory disappeared', async () => {
    const missingCwd = `${process.cwd()}-missing`
    vi.spyOn(process, 'cwd').mockReturnValue(missingCwd)
    gitExecFileAsyncMock.mockRejectedValue(
      Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT', syscall: 'spawn git' })
    )

    await expect(probeLocalGitAvailability()).rejects.toThrow('spawn git ENOENT')
  })

  it('rejects a non-spawn ENOENT rather than reporting no Git', async () => {
    gitExecFileAsyncMock.mockRejectedValue(
      Object.assign(new Error('open config ENOENT'), { code: 'ENOENT', syscall: 'open' })
    )

    await expect(probeLocalGitAvailability()).rejects.toThrow('open config ENOENT')
  })

  it('rejects on the timeout rather than reporting no git', async () => {
    gitExecFileAsyncMock.mockRejectedValue(new Error('git --version timed out after 1500ms'))
    await expect(probeLocalGitAvailability()).rejects.toThrow('timed out')
  })

  it('rejects when git runs and fails', async () => {
    gitExecFileAsyncMock.mockRejectedValue(
      Object.assign(new Error('fatal: detected dubious ownership'), { code: 128 })
    )
    await expect(probeLocalGitAvailability()).rejects.toThrow('dubious ownership')
  })
})
