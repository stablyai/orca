import { describe, expect, it } from 'vitest'
import { mergeWorktree } from './worktree-metadata-merge'
import type { GitWorktreeInfo, WorktreeMeta } from '../../shared/types'

const git = (over: Partial<GitWorktreeInfo> = {}): GitWorktreeInfo => ({
  path: '/repos/app',
  head: 'abc123',
  branch: 'refs/heads/task/WOLF-1910',
  isBare: false,
  isMainWorktree: true,
  ...over
})

const meta = (over: Partial<WorktreeMeta> = {}): WorktreeMeta => over as WorktreeMeta

describe('mergeWorktree attached reviews', () => {
  it('surfaces the persisted reviews so a caller can read back what it wrote', () => {
    // Why: this is the merge the CLI and the board both read through. Writing
    // the reviews but omitting them here persists data nothing can see, and
    // the additive --add-pr path reads the current list before merging.
    const merged = mergeWorktree(
      'repo-1',
      git(),
      meta({
        attachedReviews: [
          { provider: 'github', number: 294, url: 'https://github.com/acme/app/pull/294' },
          { provider: 'github', number: 295, url: 'https://github.com/acme/app/pull/295' }
        ]
      })
    )

    expect(merged.attachedReviews).toEqual([
      { provider: 'github', number: 294, url: 'https://github.com/acme/app/pull/294' },
      { provider: 'github', number: 295, url: 'https://github.com/acme/app/pull/295' }
    ])
  })

  it('drops corrupted entries instead of handing them to the renderer', () => {
    const merged = mergeWorktree(
      'repo-1',
      git(),
      meta({
        attachedReviews: [
          { provider: 'github', number: 294, url: 'https://github.com/acme/app/pull/294' },
          { provider: 'nope', number: 0, url: 'not-a-url' }
        ] as WorktreeMeta['attachedReviews']
      })
    )

    expect(merged.attachedReviews).toHaveLength(1)
  })

  it('omits the key when there is nothing attached', () => {
    // Why: every worktree list payload carries this merge, so an empty array on
    // each row is pure overhead. Absent and empty mean the same thing here.
    expect(mergeWorktree('repo-1', git(), meta({})).attachedReviews).toBeUndefined()
    expect(
      mergeWorktree('repo-1', git(), meta({ attachedReviews: [] })).attachedReviews
    ).toBeUndefined()
    expect(mergeWorktree('repo-1', git(), undefined).attachedReviews).toBeUndefined()
  })
})
