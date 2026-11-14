import { describe, expect, it } from 'vitest'
import {
  filterGitHubProjectRowsForRepos,
  type GitHubRepoSlugCacheEntry
} from './github-project-repo-match'

type Row = { id: number; itemType: string; content: { repository?: string | null } }

function rowsFor(repositories: readonly (string | null | undefined)[]): Row[] {
  return repositories.map((repository, id) => ({ id, itemType: 'ISSUE', content: { repository } }))
}

describe('project repository matching within one row projection', () => {
  it('does not retain matches across changed repo evidence or ambiguity', () => {
    const first = { id: 'one', path: '/one', displayName: 'one' }
    const second = { id: 'two', path: '/two', displayName: 'two' }
    const repos = [first]
    const slugs: Record<string, GitHubRepoSlugCacheEntry | undefined> = {
      one: { path: '/one', repository: { owner: 'acme', repo: 'one' } },
      two: { path: '/two', repository: { owner: 'acme', repo: 'one' } }
    }
    const rows = rowsFor(['acme/one', 'acme/one'])
    expect(filterGitHubProjectRowsForRepos(rows, repos, slugs)).toEqual(rows)
    repos.push(second)
    expect(filterGitHubProjectRowsForRepos(rows, repos, slugs)).toEqual([])
    slugs.two = { path: '/two', repository: { owner: 'other', repo: 'two' } }
    expect(filterGitHubProjectRowsForRepos(rows, repos, slugs)).toEqual(rows)
    first.path = '/moved'
    expect(filterGitHubProjectRowsForRepos(rows, repos, slugs)).toEqual([])
    slugs.one = { path: '/moved', repository: { owner: 'acme', repo: 'one' } }
    expect(filterGitHubProjectRowsForRepos(rows, repos, slugs)).toEqual(rows)
  })
})
