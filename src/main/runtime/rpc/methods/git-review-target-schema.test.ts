import { expect, it } from 'vitest'
import { GitPush } from './git-params'
import { WorktreeSet } from './worktree-schemas'
import { WorktreeCreate } from './worktree-create-schemas'
import { reviewTarget } from '../../../../shared/__fixtures__/git-review-target'

it('preserves provider head identity through push, metadata and creation RPC schemas', () => {
  const pushTarget = reviewTarget('origin', 'feature')
  expect(GitPush.parse({ worktree: 'id:wt', pushTarget }).pushTarget).toEqual(pushTarget)
  expect(WorktreeSet.parse({ worktree: 'id:wt', pushTarget }).pushTarget).toEqual(pushTarget)
  expect(
    WorktreeCreate.parse({ repo: 'id:repo', branch: 'feature', pushTarget }).pushTarget
  ).toEqual(pushTarget)
})
