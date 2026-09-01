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

import {
  _resetLocalRepoRefMaintenanceForTests,
  armLocalRepoRefMaintenance,
  createLocalRepoRefMaintenanceTarget,
  getLocalRepoRefMaintenance,
  setRepoMaintenanceActivityProbe
} from './local-repo-ref-maintenance'

function target(wslDistro?: string): ReturnType<typeof createLocalRepoRefMaintenanceTarget> {
  return createLocalRepoRefMaintenanceTarget({
    key: 'local::/repo/.git',
    repoPath: wslDistro ? '//wsl$/Ubuntu/home/dev/repo' : '/repo',
    ...(wslDistro ? { wslDistro } : {}),
    isBusy: () => false
  })
}

beforeEach(() => {
  gitExecFileAsyncMock.mockReset()
  readRepoCommonDirFromGitMock.mockReset()
  delete process.env.ORCA_DISABLE_REPO_REF_MAINTENANCE
  _resetLocalRepoRefMaintenanceForTests()
})

afterEach(() => {
  delete process.env.ORCA_DISABLE_REPO_REF_MAINTENANCE
  _resetLocalRepoRefMaintenanceForTests()
  vi.restoreAllMocks()
})

describe('local repo ref maintenance target', () => {
  it('runs pack-refs at the background tier with a long deadline', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })

    await target().packRefs()

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['pack-refs', '--all', '--prune'],
      expect.objectContaining({ cwd: '/repo', admissionTier: 'background', timeout: 15 * 60_000 })
    )
  })

  it('reads either Git auto-maintenance opt-out, and unset keys as consent', async () => {
    for (const stdout of [
      'maintenance.auto false\n',
      'gc.auto 0\n',
      'gc.auto 6700\nmaintenance.auto false\n'
    ]) {
      gitExecFileAsyncMock.mockResolvedValue({ stdout, stderr: '' })
      await expect(target().isOptedOut?.()).resolves.toBe(true)
    }

    gitExecFileAsyncMock.mockResolvedValue({
      stdout: 'maintenance.auto true\ngc.auto 6700\n',
      stderr: ''
    })
    await expect(target().isOptedOut?.()).resolves.toBe(false)

    // `git config --get-regexp` exits non-zero when nothing matches.
    gitExecFileAsyncMock.mockRejectedValue(new Error('exit 1'))
    await expect(target().isOptedOut?.()).resolves.toBe(false)
  })

  it('walks the POSIX refs directory for a native repo', async () => {
    readRepoCommonDirFromGitMock.mockResolvedValue('/repo/.git')

    await expect(target().resolveRefsDirectory()).resolves.toBe('/repo/.git/refs')
  })

  it('translates a WSL repo answer back to the UNC path the main process can open', async () => {
    // Git answers in its own execution space, which for WSL is a Linux path.
    readRepoCommonDirFromGitMock.mockResolvedValue('/home/dev/repo/.git')

    await expect(target('Ubuntu').resolveRefsDirectory()).resolves.toBe(
      '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo\\.git\\refs'
    )
  })

  it('reports an unresolvable repository rather than guessing a path', async () => {
    readRepoCommonDirFromGitMock.mockResolvedValue(undefined)

    await expect(target().resolveRefsDirectory()).resolves.toBeUndefined()
  })
})

describe('local repo ref maintenance scheduling', () => {
  it('schedules nothing when the kill switch is set', () => {
    process.env.ORCA_DISABLE_REPO_REF_MAINTENANCE = '1'
    const arm = vi.spyOn(getLocalRepoRefMaintenance(), 'arm')

    armLocalRepoRefMaintenance({ key: 'local::/repo/.git', repoPath: '/repo', isBusy: () => false })

    expect(arm).not.toHaveBeenCalled()
  })

  it('arms through the shared single-flight instance otherwise', () => {
    const arm = vi.spyOn(getLocalRepoRefMaintenance(), 'arm')

    armLocalRepoRefMaintenance({ key: 'local::/repo/.git', repoPath: '/repo', isBusy: () => false })

    expect(arm).toHaveBeenCalledTimes(1)
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
