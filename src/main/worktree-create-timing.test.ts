import { describe, expect, it } from 'vitest'
import { createWorktreeCreateTimingRecorder } from './worktree-create-timing'

describe('createWorktreeCreateTimingRecorder', () => {
  it('records ordered phase timings and total duration', async () => {
    const samples = [100, 105, 112, 130, 144, 155]
    const recorder = createWorktreeCreateTimingRecorder(() => samples.shift() ?? 155)

    const syncResult = recorder.timeSync('resolve_branch', () => 'branch')
    const asyncResult = await recorder.time('git_worktree_add', async () => 'created')

    expect(syncResult).toBe('branch')
    expect(asyncResult).toBe('created')
    expect(recorder.finish()).toEqual({
      totalDurationMs: 55,
      phases: [
        { phase: 'resolve_branch', startedAtMs: 5, durationMs: 7 },
        { phase: 'git_worktree_add', startedAtMs: 30, durationMs: 14 }
      ]
    })
  })
})
