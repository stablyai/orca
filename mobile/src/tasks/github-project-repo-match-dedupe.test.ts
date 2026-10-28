import { describe, expect, it } from 'vitest'
import {
  filterGitHubProjectRowsForRepos,
  findRepoForGitHubProjectRepository,
  type GitHubProjectRepoMatch,
  type GitHubRepoSlugCacheEntry
} from './github-project-repo-match'

type Row = { id: number; content: { repository?: string | null } }

function rowsFor(repositories: readonly (string | null | undefined)[]): Row[] {
  return repositories.map((repository, id) => ({ id, content: { repository } }))
}

describe('project repository matching within one row projection', () => {
  it('reads repository evidence once per distinct source while preserving row order and identity', () => {
    let pathReads = 0
    const repos = ['one', 'two'].map((id) => ({
      id,
      displayName: id,
      get path() {
        pathReads += 1
        return `/${id}`
      }
    }))
    const slugs = {
      one: { path: '/one', repository: { owner: 'acme', repo: 'one' } },
      two: { path: '/two', repository: { owner: 'acme', repo: 'two' } }
    }
    const repositories = ['acme/one', 'acme/two', 'missing/repo']
    const rows = rowsFor(Array.from({ length: 1_000 }, (_, index) => repositories[index % 3]))
    const actual = filterGitHubProjectRowsForRepos(rows, repos, slugs)
    expect(pathReads).toBe(6)
    const expected = rows.filter((entry) => entry.content.repository !== 'missing/repo')
    expect(actual).toEqual(expected)
    actual.forEach((entry, index) => expect(entry).toBe(expected[index]))
  })

  it('retains raw source keys and accepts the same values as individual matching', () => {
    const repos = [{ id: 'one', path: '/one', displayName: 'one' }]
    const slugs = { one: { path: '/one', repository: { owner: 'acme', repo: 'one' } } }
    const rows = rowsFor([
      undefined,
      null,
      '',
      'acme/one',
      ' ACME/ONE ',
      'acme/one/extra',
      undefined,
      null,
      '',
      'acme/one',
      ' ACME/ONE ',
      'acme/one/extra'
    ])
    const expected = rows.filter((entry) =>
      Boolean(findRepoForGitHubProjectRepository(entry.content.repository, repos, slugs))
    )
    expect(filterGitHubProjectRowsForRepos(rows, repos, slugs)).toEqual(expected)
  })

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
