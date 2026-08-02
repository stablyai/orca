import { describe, expect, it } from 'vitest'
import { pickResumeWorktree } from './resume-worktree'

const wt = (id: string, extra: { isActive?: boolean; lastOutputAt?: number } = {}) => ({
  id,
  ...extra
})

describe('pickResumeWorktree', () => {
  it('returns null for an empty list', () => {
    expect(pickResumeWorktree([])).toBeNull()
  })

  it('prefers the desktop-active worktree over list order and output time', () => {
    const list = [
      wt('a', { lastOutputAt: 999 }),
      wt('b', { isActive: true, lastOutputAt: 1 }),
      wt('c', { lastOutputAt: 500 })
    ]
    expect(pickResumeWorktree(list)?.id).toBe('b')
  })

  it('falls back to the most recent output when none is desktop-active', () => {
    const list = [wt('a', { lastOutputAt: 10 }), wt('b', { lastOutputAt: 99 }), wt('c')]
    expect(pickResumeWorktree(list)?.id).toBe('b')
  })

  it('falls back to the first when there is no output timing', () => {
    const list = [wt('a'), wt('b'), wt('c')]
    expect(pickResumeWorktree(list)?.id).toBe('a')
  })
})
