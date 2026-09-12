import { describe, expect, it } from 'vitest'
import {
  dropFailedGitHubRepoSlugEntries,
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

  it('matches an upstream project row against a fork clone', () => {
    const fork = {
      id: 'repo-1',
      path: '/Users/me/r2r-mirror',
      displayName: 'r2r-mirror',
      upstream: { owner: 'SciPhi-AI', repo: 'R2R' }
    }

    expect(
      findRepoForGitHubProjectRepository('SciPhi-AI/R2R', [fork], {
        'repo-1': {
          path: '/Users/me/r2r-mirror',
          repository: { owner: 'me', repo: 'r2r-mirror' }
        }
      })
    ).toBe(fork)
  })

  it('prefers the clone that owns the slug over a fork of it', () => {
    const upstreamClone = { id: 'repo-1', path: '/Users/me/r2r', displayName: 'r2r' }
    const fork = {
      id: 'repo-2',
      path: '/Users/me/r2r-mirror',
      displayName: 'r2r-mirror',
      upstream: { owner: 'SciPhi-AI', repo: 'R2R' }
    }

    expect(
      findRepoForGitHubProjectRepository('SciPhi-AI/R2R', [upstreamClone, fork], {
        'repo-1': {
          path: '/Users/me/r2r',
          repository: { owner: 'SciPhi-AI', repo: 'R2R' }
        },
        'repo-2': {
          path: '/Users/me/r2r-mirror',
          repository: { owner: 'me', repo: 'r2r-mirror' }
        }
      })
    ).toBe(upstreamClone)
  })

  it('does not pick a repo when two forks share the same upstream', () => {
    const forks = [
      {
        id: 'repo-1',
        path: '/Users/me/a',
        displayName: 'a',
        upstream: { owner: 'SciPhi-AI', repo: 'R2R' }
      },
      {
        id: 'repo-2',
        path: '/Users/me/b',
        displayName: 'b',
        upstream: { owner: 'SciPhi-AI', repo: 'R2R' }
      }
    ]

    expect(
      findRepoForGitHubProjectRepository('SciPhi-AI/R2R', forks, {
        'repo-1': { path: '/Users/me/a', repository: { owner: 'me', repo: 'a' } },
        'repo-2': { path: '/Users/me/b', repository: { owner: 'me', repo: 'b' } }
      })
    ).toBeNull()
  })

  it('does not bind a github.com fork parent to a same-named Enterprise row', () => {
    const fork = {
      id: 'repo-1',
      path: '/Users/me/r2r-mirror',
      displayName: 'r2r-mirror',
      upstream: { owner: 'SciPhi-AI', repo: 'R2R' }
    }

    expect(
      findRepoForGitHubProjectRepository(
        'SciPhi-AI/R2R',
        [fork],
        {
          'repo-1': {
            path: '/Users/me/r2r-mirror',
            repository: { owner: 'me', repo: 'r2r-mirror', host: 'github.com' }
          }
        },
        'github.acme-corp.com'
      )
    ).toBeNull()
  })

  it('drops the fork alias while its own origin is unresolved', () => {
    const fork = {
      id: 'repo-1',
      path: '/Users/me/widgets-mirror',
      displayName: 'widgets-mirror',
      upstream: { owner: 'acme', repo: 'widgets' }
    }

    for (const slugs of [
      {},
      { 'repo-1': { path: '/Users/me/widgets-mirror', repository: null } },
      { 'repo-1': { path: '/moved', repository: { owner: 'me', repo: 'widgets' } } }
    ]) {
      expect(findRepoForGitHubProjectRepository('acme/widgets', [fork], slugs)).toBeNull()
    }
  })

  it('scopes a host-less fork parent to the host the fork itself was cloned from', () => {
    const enterpriseFork = {
      id: 'repo-1',
      path: '/Users/me/widgets-mirror',
      displayName: 'widgets-mirror',
      upstream: { owner: 'acme', repo: 'widgets' }
    }
    const slugs = {
      'repo-1': {
        path: '/Users/me/widgets-mirror',
        repository: { owner: 'me', repo: 'widgets', host: 'github.acme-corp.com' }
      }
    }

    expect(
      findRepoForGitHubProjectRepository(
        'acme/widgets',
        [enterpriseFork],
        slugs,
        'github.acme-corp.com'
      )
    ).toBe(enterpriseFork)
    expect(findRepoForGitHubProjectRepository('acme/widgets', [enterpriseFork], slugs)).toBeNull()
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

  // Regression: a transient github.repoSlug error used to be cached as a
  // resolved "no repository", which filtered that repo's rows out forever.
  it('leaves a failed slug lookup matchable by the path fallback', () => {
    expect(
      findRepoForGitHubProjectRepository(
        'stablyai/orca',
        [{ id: 'repo-1', path: '/Users/me/stablyai/orca', displayName: 'orca' }],
        { 'repo-1': { path: '/Users/me/stablyai/orca', repository: null, failed: true } }
      )
    ).toEqual({ id: 'repo-1', path: '/Users/me/stablyai/orca', displayName: 'orca' })
  })
})

describe('dropFailedGitHubRepoSlugEntries', () => {
  it('drops only the entries a retry could still resolve', () => {
    expect(
      dropFailedGitHubRepoSlugEntries({
        'repo-1': { path: '/a', repository: { owner: 'stablyai', repo: 'orca' } },
        'repo-2': { path: '/b', repository: null, failed: true },
        'repo-3': { path: '/c', repository: null }
      })
    ).toEqual({
      'repo-1': { path: '/a', repository: { owner: 'stablyai', repo: 'orca' } },
      'repo-3': { path: '/c', repository: null }
    })
  })

  // Why: the cache is a slug-effect dependency, so a fresh object on every
  // refresh would re-run the effect even when there is nothing to retry.
  it('returns the same object when nothing failed', () => {
    const cache = { 'repo-1': { path: '/a', repository: null } }
    expect(dropFailedGitHubRepoSlugEntries(cache)).toBe(cache)
  })
})
