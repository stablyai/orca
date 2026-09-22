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
  armLocalRepoRefMaintenance,
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
  it('never hands the pack child an abort signal', async () => {
    // Killing a `pack-refs` strands a `refs/**` lock about one time in five, and
    // on Windows a force-kill inside the rewrite strands `packed-refs.lock`
    // every time. The child must always be allowed to finish.
    readRepoCommonDirFromGitMock.mockResolvedValue('/repo/.git')
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })

    await target().packRefs({ setHeld: () => {} })

    const packCall = gitExecFileAsyncMock.mock.calls.find(
      ([argv]) => (argv as string[])[0] === 'pack-refs'
    )
    expect(packCall?.[1]).not.toHaveProperty('signal')
  })

  it('runs pack-refs at the background tier with a long deadline', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })

    await target().packRefs({ setHeld: () => {} })

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
      await expect(target().isOptedOut?.(NO_ABORT)).resolves.toBe(true)
    }

    gitExecFileAsyncMock.mockResolvedValue({
      stdout: 'maintenance.auto true\ngc.auto 6700\n',
      stderr: ''
    })
    await expect(target().isOptedOut?.(NO_ABORT)).resolves.toBe(false)

    // `git config --get-regexp` exits non-zero when nothing matches.
    gitExecFileAsyncMock.mockRejectedValue(new Error('exit 1'))
    await expect(target().isOptedOut?.(NO_ABORT)).resolves.toBe(false)
  })

  it('walks the POSIX refs directory for a native repo', async () => {
    readRepoCommonDirFromGitMock.mockResolvedValue('/repo/.git')

    await expect(target().resolveRefsDirectory(NO_ABORT)).resolves.toBe('/repo/.git/refs')
  })

  it('translates a WSL repo answer back to the UNC path the main process can open', async () => {
    // Git answers in its own execution space, which for WSL is a Linux path.
    readRepoCommonDirFromGitMock.mockResolvedValue('/home/dev/repo/.git')

    await expect(target('Ubuntu').resolveRefsDirectory(NO_ABORT)).resolves.toBe(
      '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo\\.git\\refs'
    )
  })

  it('reports an unresolvable repository rather than guessing a path', async () => {
    readRepoCommonDirFromGitMock.mockResolvedValue(undefined)

    await expect(target().resolveRefsDirectory(NO_ABORT)).resolves.toBeUndefined()
  })
})

describe('local repo ref maintenance scheduling', () => {
  it('schedules nothing when the kill switch is set', () => {
    process.env.ORCA_DISABLE_REPO_REF_MAINTENANCE = '1'
    const arm = vi.spyOn(getLocalRepoRefMaintenance(), 'arm')

    armLocalRepoRefMaintenance({ key: 'local::/repo/.git', repoPath: '/repo' })

    expect(arm).not.toHaveBeenCalled()
  })

  it('arms through the shared single-flight instance otherwise', () => {
    const arm = vi.spyOn(getLocalRepoRefMaintenance(), 'arm')

    armLocalRepoRefMaintenance({ key: 'local::/repo/.git', repoPath: '/repo' })

    expect(arm).toHaveBeenCalledTimes(1)
  })

  it('is free when nothing has ever been armed', async () => {
    // The common case by far: no timers, no instance, no reason to pay anything.
    await expect(withRepoRefMaintenancePaused('git-fetch', async () => 'done')).resolves.toBe(
      'done'
    )
  })

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
