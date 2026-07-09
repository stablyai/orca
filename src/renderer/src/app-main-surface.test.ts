import { describe, expect, it } from 'vitest'
import { resolveMainSurface } from './app-main-surface'

describe('resolveMainSurface', () => {
  it('keeps activity available without an active worktree', () => {
    expect(
      resolveMainSurface({
        activeView: 'activity',
        activeWorktreeId: null,
        creationLayoutActive: false
      })
    ).toBe('activity')
  })
})
