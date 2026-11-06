import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type CaptureOptions = { signal?: AbortSignal; onChildTerminated?: () => void }
const { capture, probe, stamp, count, claimOwner, releaseOwner, stopWatch } = vi.hoisted(() => ({
  capture:
    vi.fn<
      (
        binary: string,
        argv: string[],
        options: CaptureOptions
      ) => Promise<{ stdout: string; stderr: string }>
    >(),
  probe: vi.fn(),
  stamp: vi.fn(),
  count: vi.fn(),
  claimOwner: vi.fn(),
  releaseOwner: vi.fn(),
  stopWatch: vi.fn()
}))

vi.mock('../../../../shared/loose-ref-count', () => ({ countLooseRefs: count }))
vi.mock('../../worktrees/catalog/worktree-list-reader', () => ({
  readRepoCommonDirFromGit: async () => '/repo/.git'
}))
vi.mock('./pack-refs-lock-ownership', () => ({
  PackRefsLockOwnership: class {
    claim = claimOwner
    watchLock = () => ({ stop: stopWatch })
    release = releaseOwner
  }
}))
vi.mock('../../../observability/tracer', () => ({
  withSpan: async (_name: string, run: (span: unknown) => unknown) =>
    run({ setAttribute: () => {} })
}))
vi.mock('./repo-pack-index-state', () => ({
  probeRepoPackIndexDirectory: probe,
  readRepoPackDirectoryStamp: stamp
}))
vi.mock('../../runner', async () => import('../../command-runner/git-exec-file'))
vi.mock('../../command-runner/exec-file-capture', () => ({
  execFileCapture: capture,
  execFileCaptureToTermination: capture
}))
vi.mock('../../../observability/instrumentation', () => ({
  withGitSpan: async (_args: unknown, run: (span: unknown) => unknown) =>
    run({ setAttribute: () => {} })
}))

import { RepoRefMaintenance } from '../../../../shared/repo-ref-maintenance'
import { createLocalRepoRefMaintenanceTarget } from './local-repo-ref-maintenance'
import { clearRepoPackIndexMaintenanceCache } from './repo-pack-index-maintenance'
import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import { GENERAL_CAP } from '../../../../shared/git/admission/git-admission-state'
import { GitAdmissionScheduler } from '../../../../shared/git/admission/git-admission-scheduler'
import {
  acquireGitAdmission,
  _gitAdmissionSnapshotForTests,
  _resetGitAdmissionForTests
} from '../../command-runner/git-subprocess-admission'

beforeEach(() => {
  vi.resetAllMocks()
  clearRepoPackIndexMaintenanceCache()
  _resetGitAdmissionForTests(new GitAdmissionScheduler())
  stamp.mockResolvedValue('stable-directory')
  probe.mockResolvedValue({ protected: false, packCountFloor: 64 })
  count.mockResolvedValue({ count: 1001, saturated: true })
  claimOwner.mockResolvedValue({ ok: true })
  releaseOwner.mockResolvedValue(undefined)
  capture.mockImplementation(async (_binary, argv, options) => {
    options.onChildTerminated?.()
    if (argv[0] === 'config') {
      throw Object.assign(new Error('unset'), { code: 1 })
    }
    return { stdout: '', stderr: '' }
  })
})

afterEach(() => _resetGitAdmissionForTests())

function arm(
  writer: 'multi-pack-index' | 'pack-refs',
  isBusy: () => boolean = () => false,
  quietPeriodMs = 1
): RepoRefMaintenance {
  const maintenance = new RepoRefMaintenance({ quietPeriodMs, isBusy })
  maintenance.arm(writerTarget(writer))
  return maintenance
}

function writerTarget(writer: 'multi-pack-index' | 'pack-refs', repoPath = '/repo') {
  const target = createLocalRepoRefMaintenanceTarget({
    key: `local::${repoPath}/.git`,
    repoPath
  })
  return writer === 'pack-refs' ? { ...target, maintainPackIndex: undefined } : target
}

describe('maintenance writer admission cancellation', () => {
  describe.each(['multi-pack-index', 'pack-refs'] as const)('%s re-arm admission', (writer) => {
    it.each([
      'fresh quiet period',
      'quiet timer rollover',
      'replacement eviction',
      'another repository'
    ] as const)('checks queued admission after %s', async (replacement) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const quietPeriodMs = 1000
      const blockers: { release: () => void }[] = []
      const saturate = async () => {
        blockers.push(
          ...(await Promise.all(
            Array.from({ length: GENERAL_CAP }, () =>
              acquireGitAdmission({ args: ['status'], cwd: '/blocker', tier: 'background' })
            )
          ))
        )
      }
      count.mockResolvedValue({ count: 0, saturated: false })
      if (writer === 'multi-pack-index') {
        probe.mockImplementationOnce(async () => {
          await saturate()
          return { protected: false, packCountFloor: 64 }
        })
      } else {
        count.mockImplementationOnce(async () => {
          await saturate()
          return { count: 1001, saturated: true }
        })
      }
      let busy = false
      const maintenance = arm(writer, () => busy, quietPeriodMs)
      const writerCalls = () => capture.mock.calls.filter(([, argv]) => argv[0] === writer)
      try {
        await vi.advanceTimersByTimeAsync(quietPeriodMs)
        await vi.waitFor(() => expect(_gitAdmissionSnapshotForTests().queued).toBe(1))
        const oldAttempt = maintenance.whenAttemptSettled()
        expect(writerCalls()).toHaveLength(0)
        busy = true
        maintenance.arm(
          replacement === 'another repository'
            ? { ...writerTarget(writer, '/other'), isOptedOut: async () => true }
            : writerTarget(writer)
        )
        if (replacement === 'replacement eviction') {
          for (let index = 0; index < 64; index += 1) {
            maintenance.arm({
              ...writerTarget(writer, `/other-${index}`),
              isOptedOut: async () => true
            })
          }
        } else if (replacement === 'quiet timer rollover') {
          await vi.advanceTimersByTimeAsync(quietPeriodMs)
        }
        busy = false
        blockers.forEach((blocker) => blocker.release())
        await oldAttempt
        expect(writerCalls()).toHaveLength(replacement === 'another repository' ? 1 : 0)
        expect(_gitAdmissionSnapshotForTests().queued).toBe(0)
        expect(_gitAdmissionSnapshotForTests().budgets.general?.baseUsed).toBe(0)
        if (replacement === 'fresh quiet period' || replacement === 'quiet timer rollover') {
          await vi.advanceTimersByTimeAsync(quietPeriodMs - 1)
          expect(writerCalls()).toHaveLength(0)
          if (writer === 'pack-refs') {
            count.mockResolvedValueOnce({ count: 1001, saturated: true })
          }
          await vi.advanceTimersByTimeAsync(1)
          await maintenance.whenAttemptSettled()
          expect(writerCalls()).toHaveLength(1)
        } else if (replacement === 'replacement eviction') {
          await vi.advanceTimersByTimeAsync(quietPeriodMs * 2)
          await maintenance.whenAttemptSettled()
          expect(writerCalls()).toHaveLength(0)
          expect(
            capture.mock.calls.filter(
              ([, argv]) => argv[0] === 'config' && argv[1] === '--get-regexp'
            )
          ).toHaveLength(1)
        }
      } finally {
        maintenance.dispose()
        blockers.forEach((blocker) => blocker.release())
        vi.useRealTimers()
      }
    })
  })

  it.each(['multi-pack-index', 'pack-refs'] as const)(
    'rechecks %s activity after admission and still writes on the next idle attempt',
    async (writer) => {
      const blockers: { release: () => void }[] = []
      const saturate = async () => {
        blockers.push(
          ...(await Promise.all(
            Array.from({ length: GENERAL_CAP }, () =>
              acquireGitAdmission({ args: ['status'], cwd: '/blocker', tier: 'background' })
            )
          ))
        )
      }
      count.mockResolvedValue({ count: 0, saturated: false })
      if (writer === 'multi-pack-index') {
        probe.mockImplementationOnce(async () => {
          await saturate()
          return { protected: false, packCountFloor: 64 }
        })
      } else {
        count.mockImplementationOnce(async () => {
          await saturate()
          return { count: 1001, saturated: true }
        })
      }
      let busy = false
      const maintenance = arm(writer, () => busy)
      try {
        await vi.waitFor(() => expect(_gitAdmissionSnapshotForTests().queued).toBe(1))
        busy = true
        blockers.forEach((blocker) => blocker.release())
        await maintenance.whenAttemptSettled()
        expect(capture.mock.calls.filter(([, argv]) => argv[0] === writer)).toHaveLength(0)
        expect(_gitAdmissionSnapshotForTests().budgets.general?.baseUsed).toBe(0)
        if (writer === 'multi-pack-index') {
          expect(stamp).toHaveBeenCalledOnce()
        } else {
          expect(count).toHaveBeenCalledOnce()
        }
        busy = false
        if (writer === 'pack-refs') {
          count.mockResolvedValueOnce({ count: 1001, saturated: true })
        }
        const target = createLocalRepoRefMaintenanceTarget({
          key: 'local::/repo/.git',
          repoPath: '/repo'
        })
        maintenance.arm(
          writer === 'pack-refs' ? { ...target, maintainPackIndex: undefined } : target
        )
        await vi.waitFor(() =>
          expect(capture.mock.calls.filter(([, argv]) => argv[0] === writer)).toHaveLength(1)
        )
        await maintenance.whenAttemptSettled()
        if (writer === 'multi-pack-index') {
          expect(stamp).toHaveBeenCalledTimes(3)
        } else {
          expect(count).toHaveBeenCalledTimes(3)
        }
      } finally {
        maintenance.dispose()
        blockers.forEach((blocker) => blocker.release())
      }
    }
  )

  it('releases a grant canceled before the child starts', async () => {
    const controller = new AbortController()
    const reason = new Error('Owner disposed between grant and spawn')
    _resetGitAdmissionForTests(
      new GitAdmissionScheduler({
        onAdmissionEvent: (event) => {
          if (event.phase === 'grant') {
            queueMicrotask(() => queueMicrotask(() => controller.abort(reason)))
          }
        }
      })
    )
    await expect(
      gitExecFileAsync(['multi-pack-index', 'write'], {
        cwd: '/repo',
        admissionTier: 'background',
        admissionSignal: controller.signal
      })
    ).rejects.toBe(reason)
    expect(capture).not.toHaveBeenCalled()
    expect(_gitAdmissionSnapshotForTests().budgets.general?.baseUsed).toBe(0)
  })

  it.each(['multi-pack-index', 'pack-refs'] as const)(
    'removes queued %s immediately on disposal and never starts it after slots reopen',
    async (writer) => {
      const blockers: { release: () => void }[] = []
      const saturate = async () => {
        blockers.push(
          ...(await Promise.all(
            Array.from({ length: GENERAL_CAP }, () =>
              acquireGitAdmission({ args: ['status'], cwd: '/blocker', tier: 'background' })
            )
          ))
        )
      }
      if (writer === 'multi-pack-index') {
        probe.mockImplementationOnce(async () => {
          await saturate()
          return { protected: false, packCountFloor: 64 }
        })
      } else {
        count.mockImplementationOnce(async () => {
          await saturate()
          return { count: 1001, saturated: true }
        })
      }
      const maintenance = arm(writer)
      try {
        await vi.waitFor(() =>
          expect(_gitAdmissionSnapshotForTests().queuedWaiters).toEqual([
            expect.objectContaining({
              args:
                writer === 'pack-refs'
                  ? ['pack-refs', '--all', '--prune']
                  : ['multi-pack-index', 'write']
            })
          ])
        )
        maintenance.dispose()
        expect(_gitAdmissionSnapshotForTests().queued).toBe(0)
        blockers.forEach((blocker) => blocker.release())
        await maintenance.whenAttemptSettled()
        expect(capture.mock.calls.filter(([, argv]) => argv[0] === writer)).toHaveLength(0)
        if (writer === 'pack-refs') {
          expect(stopWatch).toHaveBeenCalledOnce()
          expect(releaseOwner).toHaveBeenCalledOnce()
        }
      } finally {
        maintenance.dispose()
        blockers.forEach((blocker) => blocker.release())
      }
    }
  )

  it.each(['multi-pack-index', 'pack-refs'] as const)(
    'lets live %s settle after owner disposal without sending a child abort signal',
    async (writer) => {
      let finishWriter: (() => void) | undefined
      capture.mockImplementation(async (_binary, argv, options) => {
        if (argv[0] === 'config') {
          options.onChildTerminated?.()
          throw Object.assign(new Error('unset'), { code: 1 })
        }
        await new Promise<void>((resolve) => {
          finishWriter = resolve
        })
        options.onChildTerminated?.()
        return { stdout: '', stderr: '' }
      })
      const maintenance = arm(writer)
      try {
        await vi.waitFor(() => expect(finishWriter).toBeTypeOf('function'))
        maintenance.dispose()
        const starts = capture.mock.calls.filter(([, argv]) => argv[0] === writer)
        expect(starts).toHaveLength(1)
        expect(starts[0]?.[2].signal).toBeUndefined()
        expect(_gitAdmissionSnapshotForTests().budgets.general?.baseUsed).toBe(1)
        if (writer === 'pack-refs') {
          expect(releaseOwner).not.toHaveBeenCalled()
        }
        finishWriter?.()
        await maintenance.whenAttemptSettled()
        expect(_gitAdmissionSnapshotForTests().budgets.general?.baseUsed).toBe(0)
        if (writer === 'pack-refs') {
          expect(stopWatch).toHaveBeenCalledOnce()
          expect(releaseOwner).toHaveBeenCalledOnce()
        }
      } finally {
        maintenance.dispose()
        finishWriter?.()
      }
    }
  )
})
