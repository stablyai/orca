import { describe, expect, it } from 'vitest'
import { parseBitbucketServerRepoRef } from './server-repository-ref'

const BASE = 'https://bitbucket.example.com'

describe('parseBitbucketServerRepoRef', () => {
  it.each([
    ['https://bitbucket.example.com/scm/prj/repo.git', 'prj', 'repo'],
    ['https://user@BITBUCKET.example.com/scm/PRJ/repo.git', 'PRJ', 'repo'],
    ['ssh://git@bitbucket.example.com:7999/prj/repo.git', 'prj', 'repo'],
    ['git@bitbucket.example.com:prj/repo.git', 'prj', 'repo'],
    ['https://bitbucket.example.com/scm/~alice/repo.git', '~alice', 'repo'],
    ['https://bitbucket.example.com/scm/prj/my%20repo', 'prj', 'my repo']
  ])('parses %s on the registered host', (remote, projectKey, repoSlug) => {
    expect(parseBitbucketServerRepoRef(remote, BASE)).toEqual({
      baseUrl: BASE,
      projectKey,
      repoSlug
    })
  })

  it.each([
    'https://other.example.com/scm/prj/repo.git',
    'git@bitbucket.org:ws/repo.git',
    'https://github.com/acme/repo.git',
    'https://bitbucket.example.com/prj/repo.git',
    'not a url'
  ])('ignores %s', (remote) => {
    expect(parseBitbucketServerRepoRef(remote, BASE)).toBeNull()
  })

  it('ignores every remote when no server is registered', () => {
    expect(
      parseBitbucketServerRepoRef('https://bitbucket.example.com/scm/prj/repo.git', null)
    ).toBeNull()
  })

  it('ignores an https remote outside the registered context path', () => {
    expect(
      parseBitbucketServerRepoRef(
        'https://bitbucket.example.com/elsewhere/scm/prj/repo.git',
        'https://bitbucket.example.com/bitbucket'
      )
    ).toBeNull()
  })

  it('strips a context path from https remotes', () => {
    const base = 'https://bitbucket.example.com/bitbucket'
    expect(
      parseBitbucketServerRepoRef('https://bitbucket.example.com/bitbucket/scm/prj/repo.git', base)
    ).toEqual({ baseUrl: base, projectKey: 'prj', repoSlug: 'repo' })
  })
})
