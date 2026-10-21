import { afterEach, describe, expect, it } from 'vitest'
import { createWorktreeCreateTimingRecorder } from './worktree-create-timing'
import {
  _resetWorktreeCreateConcurrencyForTests,
  beginPreparationWork,
  beginWorktreeCreate
} from './worktree-create-concurrency'

describe('createWorktreeCreateTimingRecorder', () => {
  it('records ordered phase timings and total duration', async () => {
    const samples = [100, 105, 112, 130, 144, 155]
    const recorder = createWorktreeCreateTimingRecorder(() => samples.shift() ?? 155)

    const syncResult = recorder.timeSync('resolve_name', () => 'branch')
    const asyncResult = await recorder.time('git_worktree_add', async () => 'created')

    expect(syncResult).toBe('branch')
    expect(asyncResult).toBe('created')
    expect(recorder.finish()).toEqual({
      totalDurationMs: 55,
      phases: [
        { phase: 'resolve_name', startedAtMs: 5, durationMs: 7 },
        { phase: 'git_worktree_add', startedAtMs: 30, durationMs: 14 }
      ]
    })
  })

  it('carries the execution host and worktree count only once recorded', () => {
    const recorder = createWorktreeCreateTimingRecorder(() => 0)
    expect(recorder.finish()).not.toHaveProperty('executionHost')
    expect(recorder.finish()).not.toHaveProperty('worktreeCount')

    recorder.recordExecutionHost('local')
    recorder.recordExecutionHost('wsl')
    recorder.recordWorktreeCount(0)

    expect(recorder.finish()).toMatchObject({ executionHost: 'wsl', worktreeCount: 0 })
  })

  describe('failedPhase', () => {
    function captureRejection(promise: Promise<unknown>): Promise<unknown> {
      return promise.then(
        () => {
          throw new Error('expected a rejection')
        },
        (error: unknown) => error
      )
    }

    it('names the phase whose operation threw', async () => {
      const recorder = createWorktreeCreateTimingRecorder(() => 0)
      await recorder.time('resolve_name', async () => undefined)
      const error = await captureRejection(
        recorder.time('git_worktree_add', async () => {
          throw new Error('boom')
        })
      )

      expect(recorder.failedPhase(error)).toBe('git_worktree_add')
      // The phase that threw is still timed.
      expect(recorder.finish().phases.map((phase) => phase.phase)).toEqual([
        'resolve_name',
        'git_worktree_add'
      ])
    })

    it('is undefined for an error no phase threw', async () => {
      const recorder = createWorktreeCreateTimingRecorder(() => 0)
      await recorder.time('git_worktree_add', async () => undefined)
      expect(recorder.failedPhase(new Error('outside'))).toBeUndefined()
      expect(recorder.failedPhase('not an object')).toBeUndefined()
    })

    it('names the outermost phase an error propagated through', async () => {
      const recorder = createWorktreeCreateTimingRecorder(() => 0)
      const error = await captureRejection(
        recorder.time('git_worktree_add', () =>
          recorder.time('prepared_checkout_wait', async () => {
            throw new Error('prepare failed')
          })
        )
      )

      expect(recorder.failedPhase(error)).toBe('git_worktree_add')
    })

    it('reports untimed for a later throw after an inner failure was caught', async () => {
      const recorder = createWorktreeCreateTimingRecorder(() => 0)
      await recorder.time('git_worktree_add', async () => {
        await recorder
          .time('prepared_checkout_wait', async () => {
            throw new Error('prepare failed')
          })
          .catch(() => undefined)
      })

      expect(recorder.failedPhase(new Error('later, outside every phase'))).toBeUndefined()
    })

    it('names the rejecting phase when a concurrent sibling settles later', async () => {
      const recorder = createWorktreeCreateTimingRecorder(() => 0)
      let resolveSibling: () => void = () => {}
      const sibling = recorder.time(
        'resolve_worktreeinclude',
        () =>
          new Promise<void>((resolve) => {
            resolveSibling = resolve
          })
      )
      const error = await captureRejection(
        Promise.all([
          recorder.time('resolve_shared_directories', async () => {
            throw new Error('shared dirs failed')
          }),
          sibling
        ])
      )
      resolveSibling()
      await sibling

      expect(recorder.failedPhase(error)).toBe('resolve_shared_directories')
    })

    it('follows the cause chain of an error wrapped outside the phase', async () => {
      const recorder = createWorktreeCreateTimingRecorder(() => 0)
      const inner = await captureRejection(
        recorder.time('git_worktree_add', async () => {
          throw new Error('old relay')
        })
      )

      expect(recorder.failedPhase(new Error('wrapped', { cause: inner }))).toBe('git_worktree_add')
    })

    it('stops walking a cyclic cause chain', () => {
      const recorder = createWorktreeCreateTimingRecorder(() => 0)
      const first = new Error('first')
      const second = new Error('second', { cause: first })
      first.cause = second

      expect(recorder.failedPhase(first)).toBeUndefined()
    })

    it('names a sync phase that threw', () => {
      const recorder = createWorktreeCreateTimingRecorder(() => 0)
      let error: unknown
      try {
        recorder.timeSync('persist_metadata', () => {
          throw new Error('disk full')
        })
      } catch (caught) {
        error = caught
      }

      expect(recorder.failedPhase(error)).toBe('persist_metadata')
    })
  })

  describe('concurrency window', () => {
    afterEach(() => {
      _resetWorktreeCreateConcurrencyForTests()
    })

    it('closes at finish, so work the create starts afterwards is not counted', () => {
      const inFlight = beginWorktreeCreate()
      const recorder = createWorktreeCreateTimingRecorder(() => 0, inFlight)
      const during = beginPreparationWork()
      during.end()
      recorder.finish()
      beginPreparationWork()
      beginPreparationWork()
      expect(inFlight.end().preparations).toBe(1)
    })

    it('leaves out the prepared checkout the create adopted', () => {
      const adopted = beginPreparationWork()
      const inFlight = beginWorktreeCreate()
      const recorder = createWorktreeCreateTimingRecorder(() => 0, inFlight)
      recorder.recordAdoptedPreparation(adopted)
      recorder.finish()
      expect(inFlight.end().preparations).toBe(0)
    })
  })
})
