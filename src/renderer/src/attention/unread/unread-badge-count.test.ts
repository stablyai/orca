import { expect, it } from 'vitest'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { countUnreadWorktreesInBucket } from './unread-badge-count'

it('counts unread copies of one worktree on two hosts as two, as the sidebar shows two rows', () => {
  const id = 'repo-1::/work/feature'
  const count = countUnreadWorktreesInBucket(
    [
      makeWorktree({ id, repoId: 'repo-1', hostId: 'local', isUnread: true }),
      makeWorktree({ id, repoId: 'repo-1', hostId: 'ssh:box', isUnread: true })
    ],
    {
      repoMap: new Map(),
      visibleHostIds: null,
      defaultHostId: 'local',
      hiddenOtherDevicePairings: null
    }
  )
  expect(count).toBe(2)
})
