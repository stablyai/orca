import { describe, expect, it } from 'vitest'
import { reconcileRepoSelection } from './hosted-repo-selection'

const repos = [
  { id: 'a', kind: 'worktree' },
  { id: 'b', kind: 'worktree' },
  { id: 'folder', kind: 'folder' }
]

describe('reconcileRepoSelection', () => {
  it('drops ids this host no longer has', () => {
    expect(reconcileRepoSelection(repos, ['a', 'gone', 'folder'])).toEqual(new Set(['a']))
  })
})
