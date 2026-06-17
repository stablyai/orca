import { describe, expect, it } from 'vitest'
import { buildWorktreeSetLinkParams } from './mobile-pr-link'

describe('buildWorktreeSetLinkParams', () => {
  it('sets linkedPR to a number when linking', () => {
    expect(buildWorktreeSetLinkParams('repo42::/p', 12)).toEqual({
      worktree: 'id:repo42::/p',
      linkedPR: 12
    })
  })

  it('sets linkedPR to null when unlinking', () => {
    expect(buildWorktreeSetLinkParams('repo42::/p', null)).toEqual({
      worktree: 'id:repo42::/p',
      linkedPR: null
    })
  })
})
