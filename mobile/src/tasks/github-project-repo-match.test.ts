import { describe, expect, it } from 'vitest'
import { findRepoForGitHubProjectRepository } from './github-project-repo-match'

const repos = [
  { id: 'repo-1', path: '/Users/me/orca', displayName: 'orca' },
  { id: 'repo-2', path: '/Users/me/other', displayName: 'other' }
]

describe('GitHub project repo matching', () => {
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
})
