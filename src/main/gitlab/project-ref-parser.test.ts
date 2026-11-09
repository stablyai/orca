import { describe, expect, it } from 'vitest'
import { parseGitLabProjectRef } from './project-ref-parser'

describe('gitlab project ref parsing', () => {
  it.each([
    'ssh://git@altssh.gitlab.com:443/team/project.git',
    'git@altssh.gitlab.com:team/project.git',
    'ssh://git@ALTSSH.GITLAB.COM:443/team/project.git',
    'git@ALTSSH.GITLAB.COM:team/project.git',
    'git+ssh://git@altssh.gitlab.com:443/team/project.git'
  ])('parses the SSH alias as the canonical GitLab host: %s', (remote) => {
    expect(parseGitLabProjectRef(remote)).toEqual({
      host: 'gitlab.com',
      path: 'team/project'
    })
  })

  it.each([
    'ssh://git@altssh.gitlab.com.example.com:443/team/project.git',
    'git@altssh.gitlab.com.example.com:team/project.git',
    'git@notaltssh.gitlab.com:team/project.git'
  ])('does not trust an SSH alias lookalike: %s', (remote) => {
    expect(parseGitLabProjectRef(remote)).toBeNull()
  })

  it('drops the SSH transport port from the GitLab host identity', () => {
    // SSH ports select transport, not the web/API endpoint.
    expect(
      parseGitLabProjectRef('ssh://git@gitlab.example.com:2222/team/api.git', [
        'gitlab.com',
        'gitlab.example.com'
      ])
    ).toEqual({ host: 'gitlab.example.com', path: 'team/api' })
  })

  it('distinguishes two services on the same host by port — only the GitLab one matches', () => {
    // Same-host services on different ports must retain distinct forge identities.
    const knownHosts = ['gitlab.com', 'gitea.example.com:8443']
    expect(parseGitLabProjectRef('http://gitea.example.com:8443/team/api.git', knownHosts)).toEqual(
      { host: 'gitea.example.com:8443', path: 'team/api' }
    )
    expect(
      parseGitLabProjectRef('http://gitea.example.com:3030/team/api.git', knownHosts)
    ).toBeNull()
  })
})
