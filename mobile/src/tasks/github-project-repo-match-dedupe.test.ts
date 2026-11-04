import { describe, expect, it } from 'vitest'
import {
  filterGitHubProjectRowsForRepos,
  type GitHubProjectRepoMatch,
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

  it('rechecks the active project host and fork-origin evidence on every projection', () => {
    const repos: GitHubProjectRepoMatch[] = [
      {
        id: 'fork',
        path: '/fork',
        displayName: 'fork',
        upstream: { owner: 'acme', repo: 'one' }
      }
    ]
    const slugs: Record<string, GitHubRepoSlugCacheEntry | undefined> = {
      fork: { path: '/fork', repository: { owner: 'me', repo: 'fork', host: 'github.com' } }
    }
    const rows = rowsFor(['acme/one', 'acme/one'])
    expect(filterGitHubProjectRowsForRepos(rows, repos, slugs, 'github.com')).toEqual(rows)
    expect(filterGitHubProjectRowsForRepos(rows, repos, slugs, 'github.enterprise.test')).toEqual(
      []
    )
    slugs.fork = {
      path: '/fork',
      repository: { owner: 'me', repo: 'fork', host: 'github.enterprise.test' }
    }
    expect(filterGitHubProjectRowsForRepos(rows, repos, slugs, 'github.enterprise.test')).toEqual(
      rows
    )
    expect(filterGitHubProjectRowsForRepos(rows, repos, slugs, 'github.com')).toEqual([])
    slugs.fork = { path: '/fork', repository: null }
    expect(filterGitHubProjectRowsForRepos(rows, repos, slugs, 'github.enterprise.test')).toEqual(
      []
    )
  })
})
