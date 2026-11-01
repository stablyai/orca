import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const gitExecFileAsyncMock = vi.hoisted(() => vi.fn())
const readRepoCommonDirFromGitMock = vi.hoisted(() => vi.fn())

vi.mock('./runner', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('./worktree-list-reader', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  readRepoCommonDirFromGit: readRepoCommonDirFromGitMock
}))

import { _resetCanonicalRepoKeyCacheForTests } from './canonical-repo-key'
import {
  _resetLocalRepoRefMaintenanceForTests,
  createLocalRepoRefMaintenanceTarget,
  getLocalRepoRefMaintenance,
  setRepoMaintenanceActivityProbe,
  withRepoRefMaintenancePaused
} from './local-repo-ref-maintenance'

const NO_ABORT = new AbortController().signal

function target(wslDistro?: string): ReturnType<typeof createLocalRepoRefMaintenanceTarget> {
  return createLocalRepoRefMaintenanceTarget({
    key: 'local::/repo/.git',
    repoPath: wslDistro ? '//wsl$/Ubuntu/home/dev/repo' : '/repo',
    ...(wslDistro ? { wslDistro } : {})
  })
}

beforeEach(() => {
  gitExecFileAsyncMock.mockReset()
  readRepoCommonDirFromGitMock.mockReset()
  delete process.env.ORCA_DISABLE_REPO_REF_MAINTENANCE
  _resetCanonicalRepoKeyCacheForTests()
  _resetLocalRepoRefMaintenanceForTests()
})

afterEach(() => {
  delete process.env.ORCA_DISABLE_REPO_REF_MAINTENANCE
  _resetLocalRepoRefMaintenanceForTests()
  vi.restoreAllMocks()
})

describe('local repo ref maintenance target', () => {
  it('reads either Git auto-maintenance opt-out, and unset keys as consent', async () => {
    for (const stdout of [
      'maintenance.auto false\n',
      'maintenance.auto NO\n',
      'maintenance.auto off\n',
      'maintenance.auto 0\n',
      'maintenance.auto \n',
      'gc.auto 0\n',
      'gc.auto 0k\n',
      'gc.auto 6700\nmaintenance.auto false\n'
    ]) {
      gitExecFileAsyncMock.mockResolvedValue({ stdout, stderr: '' })
      await expect(target().isOptedOut?.(NO_ABORT)).resolves.toBe(true)
    }

    gitExecFileAsyncMock.mockResolvedValue({
      stdout: 'maintenance.auto true\ngc.auto 6700\n',
      stderr: ''
    })
    await expect(target().isOptedOut?.(NO_ABORT)).resolves.toBe(false)

    // `git config --get-regexp` exits non-zero when nothing matches.
    gitExecFileAsyncMock.mockRejectedValue(Object.assign(new Error('key unset'), { code: 1 }))
    await expect(target().isOptedOut?.(NO_ABORT)).resolves.toBe(false)
  })

  it('reports unreadable auto-maintenance config without claiming a user opt-out', async () => {
    for (const error of [
      new Error('spawn failed'),
      Object.assign(new Error('bad config'), { code: 128 })
    ]) {
      gitExecFileAsyncMock.mockRejectedValue(error)
      await expect(target().isOptedOut?.(NO_ABORT)).rejects.toBe(error)
    }
  })

  it('translates a WSL repo answer back to the UNC path the main process can open', async () => {
    readRepoCommonDirFromGitMock.mockResolvedValue('/home/dev/repo/.git')

    await expect(target('Ubuntu').resolveRefsDirectory(NO_ABORT)).resolves.toBe(
      '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo\\.git\\refs'
    )
  })
})

describe('local repo ref maintenance scheduling', () => {
  it('holds the window shut for the duration of ref-touching work', async () => {
    readRepoCommonDirFromGitMock.mockResolvedValue('/repo/.git')
    _resetLocalRepoRefMaintenanceForTests({ quietPeriodMs: 1, looseRefThreshold: 0 })
    setRepoMaintenanceActivityProbe(() => false)
    const maintenance = getLocalRepoRefMaintenance()
    const packRefs = vi.fn(async () => {})
    maintenance.arm({
      key: 'local::/repo/.git',
      resolveRefsDirectory: async () => '/repo/.git/refs',
      packRefs
    })

    await withRepoRefMaintenancePaused('branch-delete', async () => {
      await new Promise((resolve) => setTimeout(resolve, 25))
      expect(packRefs).not.toHaveBeenCalled()
    })

    await vi.waitFor(() => expect(packRefs).toHaveBeenCalledTimes(1))
  })

  it('routes the app activity probe into the shared instance', async () => {
    readRepoCommonDirFromGitMock.mockResolvedValue('/repo/.git')
    let busy = true
    setRepoMaintenanceActivityProbe(() => busy)
    const maintenance = getLocalRepoRefMaintenance()
    const packRefs = vi.fn(async () => {})

    maintenance.arm({
      key: 'local::/repo/.git',
      resolveRefsDirectory: async () => '/repo/.git/refs',
      packRefs
    })
    await maintenance.whenAttemptSettled()

    expect(packRefs).not.toHaveBeenCalled()
    busy = false
  })
})
