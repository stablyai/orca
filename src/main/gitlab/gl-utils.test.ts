import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock, glabExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  glabExecFileAsyncMock: vi.fn()
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  glabExecFileAsync: glabExecFileAsyncMock
}))

import {
  _resetKnownHostsCache,
  _resetProjectRefCache,
  classifyGlabError,
  classifyListIssuesError,
  getIssueProjectRef,
  getGlabKnownHosts,
  getProjectRef,
  parseGitLabProjectRef,
  parseGlabApiResponse,
  parseGlabAuthStatusHosts,
  resolveIssueSource
} from './gl-utils'

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

  it('preserves git protocol remote support', () => {
    expect(parseGitLabProjectRef('git://gitlab.com/acme/widgets.git')).toEqual({
      host: 'gitlab.com',
      path: 'acme/widgets'
    })
  })
})

describe('gitlab project ref resolution', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    _resetProjectRefCache()
  })

  it('keeps getProjectRef origin-based', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'git@gitlab.com:fork/orca.git\n'
    })

    await expect(getProjectRef('/repo')).resolves.toEqual({
      host: 'gitlab.com',
      path: 'fork/orca'
    })
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['remote', 'get-url', 'origin'], {
      cwd: '/repo'
    })
  })

  it('prefers upstream for issue project ref resolution', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'git@gitlab.com:stablyai/orca.git\n'
    })

    await expect(getIssueProjectRef('/repo')).resolves.toEqual({
      host: 'gitlab.com',
      path: 'stablyai/orca'
    })
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['remote', 'get-url', 'upstream'], {
      cwd: '/repo'
    })
  })

  it('falls back to origin when upstream is missing or non-GitLab', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'git@example.com:stablyai/orca.git\n' })
      .mockResolvedValueOnce({ stdout: 'git@gitlab.com:fork/orca.git\n' })

    await expect(getIssueProjectRef('/repo')).resolves.toEqual({
      host: 'gitlab.com',
      path: 'fork/orca'
    })
  })

  it('does not mix origin and upstream cache entries for the same repo path', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'git@gitlab.com:fork/orca.git\n' })
      .mockResolvedValueOnce({ stdout: 'git@gitlab.com:stablyai/orca.git\n' })

    await expect(getProjectRef('/repo')).resolves.toEqual({
      host: 'gitlab.com',
      path: 'fork/orca'
    })
    await expect(getIssueProjectRef('/repo')).resolves.toEqual({
      host: 'gitlab.com',
      path: 'stablyai/orca'
    })
  })
})

describe('resolveIssueSource', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    _resetProjectRefCache()
  })

  it("'auto' + upstream exists → upstream, fellBack=false", async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'git@gitlab.com:stablyai/orca.git\n'
    })

    await expect(resolveIssueSource('/repo', 'auto')).resolves.toEqual({
      source: { host: 'gitlab.com', path: 'stablyai/orca' },
      fellBack: false
    })
  })

  it("'auto' + no upstream → origin, fellBack=false", async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'git@example.com:stablyai/orca.git\n' })
      .mockResolvedValueOnce({ stdout: 'git@gitlab.com:solo/orca.git\n' })

    await expect(resolveIssueSource('/repo', 'auto')).resolves.toEqual({
      source: { host: 'gitlab.com', path: 'solo/orca' },
      fellBack: false
    })
  })

  it("'upstream' + no upstream remote → origin, fellBack=true", async () => {
    gitExecFileAsyncMock
      .mockRejectedValueOnce(new Error('fatal: No such remote'))
      .mockResolvedValueOnce({ stdout: 'git@gitlab.com:solo/orca.git\n' })

    await expect(resolveIssueSource('/repo', 'upstream')).resolves.toEqual({
      source: { host: 'gitlab.com', path: 'solo/orca' },
      fellBack: true
    })
  })

  it("'origin' + upstream exists → origin (ignores upstream), fellBack=false", async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'git@gitlab.com:fork/orca.git\n'
    })

    await expect(resolveIssueSource('/repo', 'origin')).resolves.toEqual({
      source: { host: 'gitlab.com', path: 'fork/orca' },
      fellBack: false
    })
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['remote', 'get-url', 'origin'], {
      cwd: '/repo'
    })
  })

  it('undefined preference is treated identically to auto', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'git@gitlab.com:stablyai/orca.git\n'
    })

    await expect(resolveIssueSource('/repo', undefined)).resolves.toEqual({
      source: { host: 'gitlab.com', path: 'stablyai/orca' },
      fellBack: false
    })
  })
})

describe('glab error classification', () => {
  it('classifies 403/forbidden as permission_denied', () => {
    expect(classifyGlabError('HTTP 403 Forbidden').type).toBe('permission_denied')
    expect(classifyGlabError('insufficient_scope').type).toBe('permission_denied')
  })

  it('classifies 404 / project not found as not_found', () => {
    expect(classifyGlabError('HTTP 404 Not Found').type).toBe('not_found')
    expect(classifyGlabError('Project Not Found').type).toBe('not_found')
  })

  it('classifies 422 / unprocessable as validation_error', () => {
    expect(classifyGlabError('HTTP 422 Unprocessable Entity').type).toBe('validation_error')
  })

  it('classifies rate-limit signals as rate_limited', () => {
    expect(classifyGlabError('HTTP 429 Too Many Requests').type).toBe('rate_limited')
    expect(classifyGlabError('rate limit exceeded').type).toBe('rate_limited')
  })

  it('classifies timeout / dns / network as network_error', () => {
    expect(classifyGlabError('connection timeout').type).toBe('network_error')
    expect(classifyGlabError('could not resolve host: gitlab.com').type).toBe('network_error')
    expect(classifyGlabError('network unreachable').type).toBe('network_error')
  })

  it('falls back to unknown for unrecognized stderr', () => {
    expect(classifyGlabError('something weird happened').type).toBe('unknown')
  })

  it('rewrites copy for read contexts via classifyListIssuesError', () => {
    expect(classifyListIssuesError('HTTP 403').message).toMatch(/permission to read issues/i)
    expect(classifyListIssuesError('HTTP 404').message).toBe('Project not found.')
  })
})

describe('glab auth status host parsing', () => {
  it('extracts hosts from "Logged in to <host>" lines', () => {
    const out = `
✓ Logged in to gitlab.com as user1 (oauth2)
✓ Logged in to gitlab.example.com as user2 (token)
    `
    expect(parseGlabAuthStatusHosts(out).sort()).toEqual(['gitlab.com', 'gitlab.example.com'])
  })

  it('extracts hosts from header-style lines', () => {
    const out = `
gitlab.example.com:
  Logged in as user2
    `
    expect(parseGlabAuthStatusHosts(out)).toContain('gitlab.example.com')
  })

  it('returns empty list for output with no hosts', () => {
    expect(parseGlabAuthStatusHosts('Not logged in.')).toEqual([])
  })
})

describe('parseGlabApiResponse', () => {
  it('splits headers and body at the first blank line (LF)', () => {
    const stdout = 'HTTP/2.0 200 OK\nX-Total: 42\nX-Total-Pages: 3\n\n[{"iid":1}]'
    const parsed = parseGlabApiResponse(stdout)
    expect(parsed.headers).toEqual({ 'x-total': '42', 'x-total-pages': '3' })
    expect(parsed.body).toBe('[{"iid":1}]')
  })

  it('handles CRLF line endings', () => {
    const stdout = 'HTTP/2.0 200 OK\r\nX-Total: 7\r\n\r\n[]'
    const parsed = parseGlabApiResponse(stdout)
    expect(parsed.headers['x-total']).toBe('7')
    expect(parsed.body).toBe('[]')
  })

  it('lowercases header names for stable lookup', () => {
    const stdout = 'HTTP/2.0 200 OK\nX-Total: 1\nContent-Type: application/json\n\n{}'
    const parsed = parseGlabApiResponse(stdout)
    expect(parsed.headers['x-total']).toBe('1')
    expect(parsed.headers['content-type']).toBe('application/json')
  })

  it('returns the full input as body when there is no header separator', () => {
    const stdout = '{"iid":1}'
    const parsed = parseGlabApiResponse(stdout)
    expect(parsed.body).toBe(stdout)
    expect(parsed.headers).toEqual({})
  })

  it('skips the status line in the header block', () => {
    const stdout = 'HTTP/2.0 200 OK\nX-Total: 5\n\n[]'
    const parsed = parseGlabApiResponse(stdout)
    // The status line should not have leaked into headers under any key.
    expect(parsed.headers['http/2.0']).toBeUndefined()
    expect(parsed.headers['x-total']).toBe('5')
  })
})

describe('getGlabKnownHosts', () => {
  beforeEach(() => {
    glabExecFileAsyncMock.mockReset()
    _resetKnownHostsCache()
  })

  it('returns gitlab.com plus auth-status hosts, deduped', async () => {
    glabExecFileAsyncMock.mockResolvedValueOnce({
      stdout: '✓ Logged in to gitlab.com as user\n✓ Logged in to gitlab.example.com as user\n',
      stderr: ''
    })

    await expect(getGlabKnownHosts()).resolves.toEqual(['gitlab.com', 'gitlab.example.com'])
  })

  it('falls back to default when glab auth status fails', async () => {
    glabExecFileAsyncMock.mockRejectedValueOnce(new Error('glab not authenticated'))

    await expect(getGlabKnownHosts()).resolves.toEqual(['gitlab.com'])
  })

  it('caches the result across calls', async () => {
    glabExecFileAsyncMock.mockResolvedValueOnce({
      stdout: '✓ Logged in to gitlab.com as user\n',
      stderr: ''
    })

    await getGlabKnownHosts()
    await getGlabKnownHosts()
    expect(glabExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })
})
