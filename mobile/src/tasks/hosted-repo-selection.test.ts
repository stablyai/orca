import { describe, expect, it } from 'vitest'
import { isHostedTaskRepo, reconcileRepoSelection } from './hosted-repo-selection'

const repos = [
  { id: 'a', kind: 'worktree' },
  { id: 'b', kind: 'worktree' },
  { id: 'folder', kind: 'folder' }
]

describe('isHostedTaskRepo', () => {
  it('excludes folder workspaces and keeps everything else', () => {
    expect(repos.filter(isHostedTaskRepo).map((repo) => repo.id)).toEqual(['a', 'b'])
    expect(isHostedTaskRepo({ id: 'no-kind' })).toBe(true)
  })
})

describe('reconcileRepoSelection', () => {
  it('treats an absent or empty persisted selection as "all repos"', () => {
    expect(reconcileRepoSelection(repos, null)).toEqual(new Set())
    expect(reconcileRepoSelection(repos, [])).toEqual(new Set())
  })

  it('drops ids this host no longer has', () => {
    expect(reconcileRepoSelection(repos, ['a', 'gone'])).toEqual(new Set(['a']))
  })

  // An empty set means "all repos", so a selection that survives nothing widens
  // back out rather than filtering every row away.
  it('widens back to all repos when nothing in the selection survives', () => {
    expect(reconcileRepoSelection(repos, ['gone'])).toEqual(new Set())
  })

  it('never selects a folder workspace', () => {
    expect(reconcileRepoSelection(repos, ['folder'])).toEqual(new Set())
  })
})
