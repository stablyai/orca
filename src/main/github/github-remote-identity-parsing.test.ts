import { describe, expect, it } from 'vitest'

import { parseGitHubOwnerRepo, parseGitHubRemoteIdentity } from './github-remote-identity-parsing'

describe('parseGitHubRemoteIdentity', () => {
  it('parses a plain github.com https remote', () => {
    expect(parseGitHubRemoteIdentity('https://github.com/team/orca.git')).toEqual({
      host: 'github.com',
      owner: 'team',
      repo: 'orca'
    })
  })

  it('parses an SCP-style github.com remote', () => {
    expect(parseGitHubRemoteIdentity('git@github.com:team/orca.git')).toEqual({
      host: 'github.com',
      owner: 'team',
      repo: 'orca'
    })
  })

  it('preserves a custom port on a GHES https remote', () => {
    // The port IS the Enterprise web/API endpoint, so gh must target
    // ghe.acme.com:8443, not the portless hostname.
    expect(parseGitHubRemoteIdentity('https://ghe.acme.com:8443/team/orca.git')).toEqual({
      host: 'ghe.acme.com:8443',
      owner: 'team',
      repo: 'orca'
    })
  })

  it('preserves a custom port on a GHES http remote', () => {
    expect(parseGitHubRemoteIdentity('http://ghe.acme.com:8080/team/orca.git')).toEqual({
      host: 'ghe.acme.com:8080',
      owner: 'team',
      repo: 'orca'
    })
  })

  it('drops the default https port so github.com stays bare', () => {
    // WHATWG URL omits default ports, so :443 never leaks into the host.
    expect(parseGitHubRemoteIdentity('https://github.com:443/team/orca.git')?.host).toBe(
      'github.com'
    )
  })

  it('drops the default https port on a GHES host', () => {
    expect(parseGitHubRemoteIdentity('https://ghe.acme.com:443/team/orca.git')?.host).toBe(
      'ghe.acme.com'
    )
  })

  it('normalizes ssh.github.com:443 (SSH-over-HTTPS) to github.com without a port', () => {
    // :443 here is the ssh transport port, not an endpoint — it must not survive.
    expect(parseGitHubRemoteIdentity('ssh://git@ssh.github.com:443/team/orca.git')).toEqual({
      host: 'github.com',
      owner: 'team',
      repo: 'orca'
    })
  })

  it('drops a custom ssh transport port on a GHES ssh remote', () => {
    // ssh://…:2222 is a transport port; gh routes by hostname, so keep only the host.
    expect(parseGitHubRemoteIdentity('ssh://git@ghe.acme.com:2222/team/orca.git')?.host).toBe(
      'ghe.acme.com'
    )
  })

  it('drops the transport port for git+ssh and git remotes', () => {
    expect(parseGitHubRemoteIdentity('git+ssh://git@ghe.acme.com:2222/team/orca.git')?.host).toBe(
      'ghe.acme.com'
    )
    expect(parseGitHubRemoteIdentity('git://ghe.acme.com:9418/team/orca.git')?.host).toBe(
      'ghe.acme.com'
    )
  })

  it('lowercases the host while keeping the port', () => {
    expect(parseGitHubRemoteIdentity('https://GHE.Acme.COM:8443/team/orca.git')?.host).toBe(
      'ghe.acme.com:8443'
    )
  })

  it('returns null for an unparseable remote', () => {
    expect(parseGitHubRemoteIdentity('not-a-remote')).toBeNull()
  })
})

describe('parseGitHubOwnerRepo', () => {
  it('returns owner/repo for github.com', () => {
    expect(parseGitHubOwnerRepo('https://github.com/team/orca.git')).toEqual({
      owner: 'team',
      repo: 'orca'
    })
  })

  it('returns null for a custom-port GHES remote (not github.com)', () => {
    // GHES is handled by the enterprise resolver, not the github.com fast path,
    // and the port must not make a github.com remote look like GHES either.
    expect(parseGitHubOwnerRepo('https://ghe.acme.com:8443/team/orca.git')).toBeNull()
  })

  it('still recognizes github.com even with an explicit default port', () => {
    expect(parseGitHubOwnerRepo('https://github.com:443/team/orca.git')).toEqual({
      owner: 'team',
      repo: 'orca'
    })
  })
})
