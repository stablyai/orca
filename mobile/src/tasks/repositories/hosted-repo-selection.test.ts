import { describe, expect, it } from 'vitest'
import { reconcileRepoSelection } from './hosted-repo-selection'

const repos = [
  { id: 'a', kind: 'worktree' },
  { id: 'b', kind: 'worktree' },
  { id: 'folder', kind: 'folder' }
]

describe('reconcileRepoSelection', () => {
  it('drops ids this host no longer has', () => {
    expect(reconcileRepoSelection(repos, ['a', 'gone'])).toEqual(new Set(['a']))
  })

  it('never selects a folder workspace', () => {
    expect(reconcileRepoSelection(repos, ['folder'])).toEqual(new Set())
  })
})
