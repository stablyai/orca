import { describe, expect, it } from 'vitest'
import { parseGitLabProjectRef, parseRemoteProjectRefCandidate } from './project-ref-parser'

describe('gitlab project ref parsing', () => {
  it('parses HTTPS and SSH GitLab.com remotes', () => {
    expect(parseGitLabProjectRef('https://gitlab.com/acme/widgets.git')).toEqual({
      host: 'gitlab.com',
      path: 'acme/widgets'
    })
    expect(parseGitLabProjectRef('git@gitlab.com:stablyai/orca.git')).toEqual({
      host: 'gitlab.com',
      path: 'stablyai/orca'
    })
  })

  it('preserves nested group paths', () => {
    expect(parseGitLabProjectRef('git@gitlab.com:group/subgroup/project.git')).toEqual({
      host: 'gitlab.com',
      path: 'group/subgroup/project'
    })
    expect(parseGitLabProjectRef('https://gitlab.com/g1/g2/g3/proj.git')).toEqual({
      host: 'gitlab.com',
      path: 'g1/g2/g3/proj'
    })
  })

  it('returns null for non-GitLab hosts when host not in knownHosts', () => {
    expect(parseGitLabProjectRef('git@github.com:stablyai/orca.git')).toBeNull()
    expect(parseGitLabProjectRef('git@example.com:foo/bar.git')).toBeNull()
  })

  it('matches self-hosted hosts when included in knownHosts', () => {
    expect(
      parseGitLabProjectRef('git@gitlab.example.com:team/api.git', [
        'gitlab.com',
        'gitlab.example.com'
      ])
    ).toEqual({ host: 'gitlab.example.com', path: 'team/api' })
  })

  it('drops the SSH transport port from the GitLab host identity', () => {
    // Why: for ssh remotes the port is a transport port (e.g. :2222), not the
    // web/API endpoint, so it must not become part of the recognized host.
    expect(
      parseGitLabProjectRef('ssh://git@gitlab.example.com:2222/team/api.git', [
        'gitlab.com',
        'gitlab.example.com'
      ])
    ).toEqual({ host: 'gitlab.example.com', path: 'team/api' })
  })

  it('keeps the HTTP(S) port as part of the self-hosted GitLab host identity', () => {
    // Why: a self-hosted GitLab served on a non-default web port (e.g. :8443)
    // is identified by host:port end-to-end so `glab --hostname` targets it.
    expect(
      parseGitLabProjectRef('https://gitlab.example.com:8443/team/api.git', [
        'gitlab.com',
        'gitlab.example.com:8443'
      ])
    ).toEqual({ host: 'gitlab.example.com:8443', path: 'team/api' })
  })

  it('matches a port-bearing http remote against a port-less legacy known host', () => {
    // Why: a known host recorded without a port (legacy/bare entry) still
    // recognizes a remote on any port of the same hostname.
    expect(
      parseGitLabProjectRef('https://gitlab.example.com:8443/team/api.git', [
        'gitlab.com',
        'gitlab.example.com'
      ])
    ).toEqual({ host: 'gitlab.example.com:8443', path: 'team/api' })
  })

  it('distinguishes two services on the same host by port — only the GitLab one matches', () => {
    // Why: a GitLab on :8443 and a Gitea on :3030 share a hostname but are
    // different services. With only the GitLab port in known hosts, the Gitea
    // remote must NOT be classified as GitLab.
    const knownHosts = ['gitlab.com', 'gitea.example.com:8443']
    expect(parseGitLabProjectRef('http://gitea.example.com:8443/team/api.git', knownHosts)).toEqual(
      { host: 'gitea.example.com:8443', path: 'team/api' }
    )
    expect(
      parseGitLabProjectRef('http://gitea.example.com:3030/team/api.git', knownHosts)
    ).toBeNull()
  })

  it('matches an SCP-like self-hosted remote against a port-less known host', () => {
    expect(
      parseGitLabProjectRef('git@gitlab.example.com:team/api.git', [
        'gitlab.com',
        'gitlab.example.com'
      ])
    ).toEqual({ host: 'gitlab.example.com', path: 'team/api' })
  })

  it('keeps gitlab.com (no port) recognized as a default host', () => {
    expect(parseGitLabProjectRef('https://gitlab.com/acme/widgets.git')).toEqual({
      host: 'gitlab.com',
      path: 'acme/widgets'
    })
  })

  it('rejects single-segment paths (host root or user-only)', () => {
    expect(parseGitLabProjectRef('git@gitlab.com:foo.git')).toBeNull()
    expect(parseGitLabProjectRef('https://gitlab.com/foo.git')).toBeNull()
  })

  it('handles missing .git suffix', () => {
    expect(parseGitLabProjectRef('https://gitlab.com/acme/widgets')).toEqual({
      host: 'gitlab.com',
      path: 'acme/widgets'
    })
  })

  it('strips trailing slashes after .git suffixes', () => {
    expect(parseGitLabProjectRef('https://gitlab.com/acme/widgets.git/')).toEqual({
      host: 'gitlab.com',
      path: 'acme/widgets'
    })
    expect(parseGitLabProjectRef('ssh://git@gitlab.com/acme/widgets.git/')).toEqual({
      host: 'gitlab.com',
      path: 'acme/widgets'
    })
  })

  it('preserves git protocol remote support', () => {
    expect(parseGitLabProjectRef('git://gitlab.com/acme/widgets.git')).toEqual({
      host: 'gitlab.com',
      path: 'acme/widgets'
    })
  })
})

describe('gitlab remote project ref candidates', () => {
  it('extracts self-hosted candidates before the host is trusted', () => {
    expect(parseRemoteProjectRefCandidate('git@gitlab.internal:team/orca.git')).toEqual({
      host: 'gitlab.internal',
      path: 'team/orca'
    })
  })

  it('rejects non-git URLs and single-segment project paths', () => {
    expect(parseRemoteProjectRefCandidate('file:///tmp/repo')).toBeNull()
    expect(parseRemoteProjectRefCandidate('git@gitlab.internal:team.git')).toBeNull()
  })
})
