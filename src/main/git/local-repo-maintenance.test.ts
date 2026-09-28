import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GitRunner from './runner'
import type * as WorktreeListReader from './worktree-list-reader'

const gitExecFileAsyncMock = vi.hoisted(() =>
  vi.fn<
    (
      argv: string[],
      options: Record<string, unknown>
    ) => Promise<{
      stdout: string
      stderr: string
    }>
  >()
)
const readRepoCommonDirFromGitMock = vi.hoisted(() => vi.fn())

vi.mock('./runner', async (importOriginal) => ({
  ...(await importOriginal<typeof GitRunner>()),
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('./worktree-list-reader', async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreeListReader>()),
  readRepoCommonDirFromGit: readRepoCommonDirFromGitMock
}))

import type {
  RepoMaintenanceTarget,
  RepoMaintenanceTask,
  RepoMaintenanceTaskId
} from '../../shared/repo-maintenance-policy'
import { _resetCanonicalRepoKeyCacheForTests } from './canonical-repo-key'
import {
  _resetLocalRepoMaintenanceForTests,
  armLocalRepoMaintenance,
  createLocalRepoMaintenanceTarget,
  getLocalRepoMaintenance,
  setRepoMaintenanceActivityProbe,
  withRepoMaintenancePaused
} from './local-repo-maintenance'

const NO_ABORT = new AbortController().signal
const NO_LOCK = { setHeld: () => {} }

function target(wslDistro?: string): RepoMaintenanceTarget {
  return createLocalRepoMaintenanceTarget({
    key: 'local::/repo/.git',
    repoPath: wslDistro ? '//wsl$/Ubuntu/home/dev/repo' : '/repo',
    ...(wslDistro ? { wslDistro } : {})
  })
}

function taskOf(id: RepoMaintenanceTaskId, wslDistro?: string): RepoMaintenanceTask {
  const task = target(wslDistro).tasks.find((candidate) => candidate.id === id)
  if (!task) {
    throw new Error(`no ${id} task on the local target`)
  }
  return task
}

/** A target whose tasks record their order without touching a repository. */
function recordingTarget(order: string[]): RepoMaintenanceTarget {
  const real = target()
  return {
    ...real,
    tasks: real.tasks.map((task) => {
      let packed = false
      return {
        ...task,
        probeBacklog: async () => ({ count: packed ? 0 : task.threshold, saturated: false }),
        pack: async () => {
          order.push(task.id)
          packed = true
          return { batchExhausted: false }
        }
      }
    })
  }
}

beforeEach(() => {
  gitExecFileAsyncMock.mockReset()
  readRepoCommonDirFromGitMock.mockReset()
  delete process.env.ORCA_DISABLE_REPO_MAINTENANCE
  delete process.env.ORCA_DISABLE_REPO_REF_MAINTENANCE
  _resetCanonicalRepoKeyCacheForTests()
  _resetLocalRepoMaintenanceForTests()
})

afterEach(() => {
  delete process.env.ORCA_DISABLE_REPO_MAINTENANCE
  delete process.env.ORCA_DISABLE_REPO_REF_MAINTENANCE
  _resetLocalRepoMaintenanceForTests()
  vi.restoreAllMocks()
})

describe('local repo maintenance target', () => {
  it('carries the ref, loose-object and kept-pack tasks, in that order', () => {
    expect(target().tasks.map((task) => task.id)).toEqual(['refs', 'objects', 'object-packs'])
  })

  it('runs the ref task before the object task inside one attempt', async () => {
    readRepoCommonDirFromGitMock.mockResolvedValue('/repo/.git')
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })
    _resetLocalRepoMaintenanceForTests({ quietPeriodMs: 1 })
    setRepoMaintenanceActivityProbe(() => ({ interactive: false, constrained: false }))
    const order: string[] = []

    getLocalRepoMaintenance().arm(recordingTarget(order))
    await vi.waitFor(() => expect(order).toEqual(['refs', 'objects', 'object-packs']))
  })

  it('packs objects while agents are working, and leaves refs for a quiet window', async () => {
    readRepoCommonDirFromGitMock.mockResolvedValue('/repo/.git')
    gitExecFileAsyncMock.mockRejectedValue(new Error('exit 1'))
    _resetLocalRepoMaintenanceForTests({ quietPeriodMs: 1 })
    setRepoMaintenanceActivityProbe(() => ({ interactive: true, constrained: false }))
    const order: string[] = []

    getLocalRepoMaintenance().arm(recordingTarget(order))
    await vi.waitFor(() => expect(order).toEqual(['objects', 'object-packs']))
    await getLocalRepoMaintenance().whenAttemptSettled()
    expect(order).toEqual(['objects', 'object-packs'])
  })

  it('packs nothing at all when the gate cannot be seen', async () => {
    readRepoCommonDirFromGitMock.mockResolvedValue('/repo/.git')
    _resetLocalRepoMaintenanceForTests({ quietPeriodMs: 1 })
    const order: string[] = []

    getLocalRepoMaintenance().arm(recordingTarget(order))
    await new Promise((resolve) => setTimeout(resolve, 25))

    expect(order).toEqual([])
  })

  it('never hands the pack child an abort signal', async () => {
    // Killing a `pack-refs` strands a `refs/**` lock about one time in five, and
    // on Windows a force-kill inside the rewrite strands `packed-refs.lock`
    // every time. The child must always be allowed to finish.
    readRepoCommonDirFromGitMock.mockResolvedValue('/repo/.git')
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })

    await taskOf('refs').pack(NO_LOCK)

    const packCall = gitExecFileAsyncMock.mock.calls.find(([argv]) => argv[0] === 'pack-refs')
    expect(packCall?.[1]).not.toHaveProperty('signal')
  })

  it('runs pack-refs at the background tier with a long deadline', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })

    await taskOf('refs').pack(NO_LOCK)

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['pack-refs', '--all', '--prune'],
      expect.objectContaining({ cwd: '/repo', admissionTier: 'background', timeout: 15 * 60_000 })
    )
  })

  it("reads either Git auto-maintenance opt-out through Git's typed config", async () => {
    const config = (values: Record<string, string | undefined>) =>
      gitExecFileAsyncMock.mockImplementation(async (argv) => {
        const value = values[argv.at(-1) ?? '']
        if (value === undefined) {
          throw new Error('exit 1')
        }
        return { stdout: `${value}\n`, stderr: '' }
      })

    for (const values of [
      { 'maintenance.auto': 'false' },
      { 'gc.auto': '0' },
      { 'gc.auto': '-1' },
      { 'maintenance.auto': 'true', 'gc.auto': '0' }
    ]) {
      config(values)
      await expect(target().isOptedOut?.(NO_ABORT)).resolves.toBe(true)
    }
    for (const values of [{}, { 'maintenance.auto': 'true', 'gc.auto': '6700' }]) {
      config(values)
      await expect(target().isOptedOut?.(NO_ABORT)).resolves.toBe(false)
    }

    // Git does the spelling: `no`/`off`/`0` come back as `false`, `1k` as `1024`.
    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0])).toContainEqual([
      'config',
      '--type=bool',
      '--get',
      'maintenance.auto'
    ])
    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0])).toContainEqual([
      'config',
      '--type=int',
      '--get',
      'gc.auto'
    ])
  })

  it('reports an unresolvable repository rather than guessing a path', async () => {
    readRepoCommonDirFromGitMock.mockResolvedValue(undefined)

    for (const id of ['refs', 'objects', 'object-packs'] as const) {
      await expect(taskOf(id).probeBacklog(10, NO_ABORT)).resolves.toBeUndefined()
    }
  })
})

describe('local repo maintenance scheduling', () => {
  it('schedules nothing when the kill switch is set', () => {
    process.env.ORCA_DISABLE_REPO_MAINTENANCE = '1'
    const arm = vi.spyOn(getLocalRepoMaintenance(), 'arm')

    armLocalRepoMaintenance({ key: 'local::/repo/.git', repoPath: '/repo' })

    expect(arm).not.toHaveBeenCalled()
  })

  it('still honours the name support handed out for the loose-ref-only sweep', () => {
    process.env.ORCA_DISABLE_REPO_REF_MAINTENANCE = '1'
    const arm = vi.spyOn(getLocalRepoMaintenance(), 'arm')

    armLocalRepoMaintenance({ key: 'local::/repo/.git', repoPath: '/repo' })

    expect(arm).not.toHaveBeenCalled()
  })

  it('arms through the shared single-flight instance otherwise', () => {
    const arm = vi.spyOn(getLocalRepoMaintenance(), 'arm')

    armLocalRepoMaintenance({ key: 'local::/repo/.git', repoPath: '/repo' })

    expect(arm).toHaveBeenCalledTimes(1)
  })

  it('is free when nothing has ever been armed', async () => {
    // The common case by far: no timers, no instance, no reason to pay anything.
    await expect(withRepoMaintenancePaused('git-fetch', async () => 'done')).resolves.toBe('done')
  })

  it('holds the window shut for the duration of ref-touching work', async () => {
    readRepoCommonDirFromGitMock.mockResolvedValue('/repo/.git')
    _resetLocalRepoMaintenanceForTests({ quietPeriodMs: 1 })
    setRepoMaintenanceActivityProbe(() => ({ interactive: false, constrained: false }))
    const maintenance = getLocalRepoMaintenance()
    const pack = vi.fn(async () => ({ batchExhausted: false }))
    maintenance.arm({
      key: 'local::/repo/.git',
      tasks: [
        {
          id: 'refs',
          threshold: 0,
          probeBacklog: async () => ({ count: 0, saturated: false }),
          pack
        }
      ]
    })

    await withRepoMaintenancePaused('branch-delete', async () => {
      await new Promise((resolve) => setTimeout(resolve, 25))
      expect(pack).not.toHaveBeenCalled()
    })

    await vi.waitFor(() => expect(pack).toHaveBeenCalledTimes(1))
  })

  it('routes the app activity probe into the shared instance', async () => {
    readRepoCommonDirFromGitMock.mockResolvedValue('/repo/.git')
    let busy = true
    setRepoMaintenanceActivityProbe(() => ({ interactive: busy, constrained: busy }))
    const maintenance = getLocalRepoMaintenance()
    const pack = vi.fn(async () => ({ batchExhausted: false }))

    maintenance.arm({
      key: 'local::/repo/.git',
      tasks: [
        {
          id: 'refs',
          threshold: 0,
          probeBacklog: async () => ({ count: 0, saturated: false }),
          pack
        }
      ]
    })
    await maintenance.whenAttemptSettled()

    expect(pack).not.toHaveBeenCalled()
    busy = false
  })
})
