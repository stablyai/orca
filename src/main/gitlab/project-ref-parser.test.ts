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

  it('parses GitLab remotes with non-standard ports without treating the port as a path segment', () => {
    expect(
      parseGitLabProjectRef('ssh://git@gitlab.example.com:2222/team/api.git', [
        'gitlab.com',
        'gitlab.example.com'
      ])
    ).toEqual({ host: 'gitlab.example.com', path: 'team/api' })
    expect(
      parseGitLabProjectRef('https://gitlab.example.com:8443/team/api.git', [
        'gitlab.com',
        'gitlab.example.com'
      ])
    ).toEqual({ host: 'gitlab.example.com', path: 'team/api' })
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
