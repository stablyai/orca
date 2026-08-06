import { describe, expect, it } from 'vitest'
import {
  filterGitHubProjectRowsForRepos,
  findRepoForGitHubProjectRepository,
  normalizeGitHubRepositorySlug
} from './github-project-repo-match'

const repos = [
  { id: 'repo-1', path: '/Users/me/orca', displayName: 'orca' },
  { id: 'repo-2', path: '/Users/me/other', displayName: 'other' }
]

describe('GitHub project repo matching', () => {
  it('normalizes owner/repo slugs case-insensitively', () => {
    expect(normalizeGitHubRepositorySlug(' StablyAI/Orca ')).toBe('stablyai/orca')
    expect(normalizeGitHubRepositorySlug('orca')).toBeNull()
    expect(normalizeGitHubRepositorySlug('stablyai/orca/extra')).toBeNull()
  })

  it('matches project rows by resolved repo slug before path/display heuristics', () => {
    expect(
      findRepoForGitHubProjectRepository('stablyai/orca', repos, {
        'repo-1': {
          path: '/Users/me/orca',
          repository: { owner: 'stablyai', repo: 'orca' }
        }
      })
    ).toBe(repos[0])
  })

  it('does not pick a repo when resolved slugs are ambiguous', () => {
    expect(
      findRepoForGitHubProjectRepository('stablyai/orca', repos, {
        'repo-1': {
          path: '/Users/me/orca',
          repository: { owner: 'stablyai', repo: 'orca' }
        },
        'repo-2': {
          path: '/Users/me/other',
          repository: { owner: 'stablyai', repo: 'orca' }
        }
      })
    ).toBeNull()
  })

  it('falls back to exact display/path slug matching when slug resolution is unavailable', () => {
    expect(
      findRepoForGitHubProjectRepository('stablyai/orca', [
        { id: 'repo-1', path: '/Users/me/stablyai/orca', displayName: 'orca' }
      ])
    ).toEqual({ id: 'repo-1', path: '/Users/me/stablyai/orca', displayName: 'orca' })
  })

  it('normalizes Windows paths before path slug fallback matching', () => {
    expect(
      findRepoForGitHubProjectRepository('stablyai/orca', [
        { id: 'repo-1', path: 'C:\\Users\\me\\stablyai\\orca', displayName: 'orca' }
      ])
    ).toEqual({ id: 'repo-1', path: 'C:\\Users\\me\\stablyai\\orca', displayName: 'orca' })
  })

  it('does not path-match a repo whose resolved slug points somewhere else', () => {
    expect(
      findRepoForGitHubProjectRepository(
        'stablyai/orca',
        [{ id: 'repo-1', path: '/Users/me/stablyai/orca', displayName: 'orca' }],
        {
          'repo-1': {
            path: '/Users/me/stablyai/orca',
            repository: { owner: 'fork', repo: 'orca' }
          }
        }
      )
    ).toBeNull()
  })

  it('filters project rows to rows backed by open repositories', () => {
    const rows = [
      { id: 'row-1', content: { repository: 'stablyai/orca' } },
      { id: 'row-2', content: { repository: 'other/missing' } },
      { id: 'row-3', content: { repository: null } }
    ]

    expect(
      filterGitHubProjectRowsForRepos(rows, repos, {
        'repo-1': {
          path: '/Users/me/orca',
          repository: { owner: 'stablyai', repo: 'orca' }
        }
      }).map((row) => row.id)
    ).toEqual(['row-1'])
  })

  it('matches same-named repositories only on the active Project host', () => {
    expect(
      findRepoForGitHubProjectRepository(
        'stablyai/orca',
        repos,
        {
          'repo-1': {
            path: '/Users/me/orca',
            repository: { owner: 'stablyai', repo: 'orca', host: 'github.com' }
          },
          'repo-2': {
            path: '/Users/me/other',
            repository: {
              owner: 'stablyai',
              repo: 'orca',
              host: 'github.acme-corp.com'
            }
          }
        },
        'github.acme-corp.com'
      )
    ).toBe(repos[1])
  })

  it('does not use hostless path heuristics for Enterprise Project rows', () => {
    expect(
      findRepoForGitHubProjectRepository(
        'stablyai/orca',
        [{ id: 'repo-1', path: '/Users/me/stablyai/orca', displayName: 'orca' }],
        {},
        'github.acme-corp.com'
      )
    ).toBeNull()
  })
})
