import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock, glabExecFileAsyncMock, sshExecMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  glabExecFileAsyncMock: vi.fn(),
  sshExecMock: vi.fn()
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  glabExecFileAsync: glabExecFileAsyncMock
}))

import {
  _getProjectRefCacheSize,
  _resetKnownHostsCache,
  _resetProjectRefCache,
  classifyGlabError,
  classifyListIssuesError,
  getIssueProjectRef,
  getGlabKnownHosts,
  getProjectRef,
  getProjectRefForRemote,
  parseGlabApiResponse,
  parseGlabAuthStatusHosts,
  resolveIssueSource
} from './gl-utils'
import { registerSshGitProvider, unregisterSshGitProvider } from '../providers/ssh-git-dispatch'

describe('gitlab project ref resolution', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    sshExecMock.mockReset()
    unregisterSshGitProvider('conn-1')
    _resetProjectRefCache()
  })

  afterEach(() => {
    unregisterSshGitProvider('conn-1')
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

  it('keeps local host and local WSL project-ref cache entries separate for the same path', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'git@gitlab.com:host/orca.git\n' })
      .mockResolvedValueOnce({ stdout: 'git@gitlab.com:wsl/orca.git\n' })

    await expect(getProjectRef('/repo')).resolves.toEqual({
      host: 'gitlab.com',
      path: 'host/orca'
    })
    await expect(getProjectRef('/repo', undefined, null, { wslDistro: 'Ubuntu' })).resolves.toEqual(
      {
        host: 'gitlab.com',
        path: 'wsl/orca'
      }
    )
    await expect(getProjectRef('/repo', undefined, null, { wslDistro: 'Ubuntu' })).resolves.toEqual(
      {
        host: 'gitlab.com',
        path: 'wsl/orca'
      }
    )

    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(2)
    expect(gitExecFileAsyncMock).toHaveBeenNthCalledWith(1, ['remote', 'get-url', 'origin'], {
      cwd: '/repo'
    })
    expect(gitExecFileAsyncMock).toHaveBeenNthCalledWith(2, ['remote', 'get-url', 'origin'], {
      cwd: '/repo',
      wslDistro: 'Ubuntu'
    })
  })

  it('coalesces concurrent missing remote probes for the same repo and remote', async () => {
    gitExecFileAsyncMock.mockImplementation(async () => {
      await Promise.resolve()
      throw new Error("error: No such remote 'upstream'")
    })

    await expect(
      Promise.all([
        getProjectRefForRemote('/repo', 'upstream'),
        getProjectRefForRemote('/repo', 'upstream'),
        getProjectRefForRemote('/repo', 'upstream'),
        getProjectRefForRemote('/repo', 'upstream')
      ])
    ).resolves.toEqual([null, null, null, null])

    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['remote', 'get-url', 'upstream'], {
      cwd: '/repo'
    })

    await expect(getProjectRefForRemote('/repo', 'upstream')).resolves.toBeNull()
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('resolves project refs through the SSH git provider for connected repos', async () => {
    sshExecMock.mockResolvedValueOnce({ stdout: 'git@gitlab.com:remote/orca.git\n', stderr: '' })
    registerSshGitProvider('conn-1', { exec: sshExecMock } as never)

    await expect(getProjectRefForRemote('/repo', 'origin', undefined, 'conn-1')).resolves.toEqual({
      host: 'gitlab.com',
      path: 'remote/orca'
    })

    expect(sshExecMock).toHaveBeenCalledWith(['remote', 'get-url', 'origin'], '/repo')
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('bounds cached project refs for distinct repo paths', async () => {
    gitExecFileAsyncMock.mockResolvedValue({
      stdout: 'git@gitlab.com:stablyai/orca.git\n',
      stderr: ''
    })

    for (let i = 0; i < 513; i += 1) {
      await getProjectRef(`/repo-${i}`)
    }

    expect(_getProjectRefCacheSize()).toBe(512)
  })

  it('does not cache a missing SSH provider as a permanent null project ref', async () => {
    await expect(getProjectRefForRemote('/repo', 'origin', undefined, 'conn-1')).resolves.toBeNull()

    sshExecMock.mockResolvedValueOnce({
      stdout: 'git@gitlab.com:remote/orca.git\n',
      stderr: ''
    })
    registerSshGitProvider('conn-1', { exec: sshExecMock } as never)

    await expect(getProjectRefForRemote('/repo', 'origin', undefined, 'conn-1')).resolves.toEqual({
      host: 'gitlab.com',
      path: 'remote/orca'
    })
  })

  it('does not cache transient SSH exec failures as permanent null project refs', async () => {
    sshExecMock
      .mockRejectedValueOnce(new Error('ssh tunnel not ready'))
      .mockResolvedValueOnce({ stdout: 'git@gitlab.com:remote/orca.git\n', stderr: '' })
    registerSshGitProvider('conn-1', { exec: sshExecMock } as never)

    await expect(getProjectRefForRemote('/repo', 'origin', undefined, 'conn-1')).resolves.toBeNull()
    await expect(getProjectRefForRemote('/repo', 'origin', undefined, 'conn-1')).resolves.toEqual({
      host: 'gitlab.com',
      path: 'remote/orca'
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

  it('extracts hosts from bare auth-status section headers', () => {
    const out = `
gitlab.com
  ✓ Logged in to gitlab.com as user1 (/home/user/.config/glab-cli/config.yml)
  ✓ Token: **************************
gitlab.internal
  ✓ Logged in as user2
  ✓ Token: **************************
Self-hosted-git
  ✓ Logged in as user3
    `
    expect(parseGlabAuthStatusHosts(out).sort()).toEqual([
      'gitlab.com',
      'gitlab.internal',
      'self-hosted-git'
    ])
  })

  it('returns empty list for output with no hosts', () => {
    expect(parseGlabAuthStatusHosts('Not logged in.')).toEqual([])
  })

  it('captures a non-default port on "Logged in to" lines', () => {
    const out = '✓ Logged in to gitlab.example.com:8080 as user (token)'
    expect(parseGlabAuthStatusHosts(out)).toEqual(['gitlab.example.com:8080'])
  })

  it('captures a non-default port on header-style lines', () => {
    const out = `
gitlab.example.com:8080:
  ✓ Logged in as user
    `
    expect(parseGlabAuthStatusHosts(out)).toContain('gitlab.example.com:8080')
  })

  it('keeps two services on the same host distinct by port', () => {
    const out = `
✓ Logged in to gitlab.example.com:8443 as user (token)
✓ Logged in to gitlab.example.com:3030 as user (token)
    `
    expect(parseGlabAuthStatusHosts(out).sort()).toEqual([
      'gitlab.example.com:3030',
      'gitlab.example.com:8443'
    ])
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

  it('splits large bodies without full-output separator matching', () => {
    const matchSpy = vi.spyOn(String.prototype, 'match')
    const body = '[{"iid":1}]'.repeat(10_000)
    const parsed = parseGlabApiResponse(`HTTP/2.0 200 OK\r\nX-Total: 7\r\n\r\n${body}`)

    expect(parsed.headers['x-total']).toBe('7')
    expect(parsed.body).toBe(body)
    const usedSeparatorMatch = matchSpy.mock.calls.some(
      ([pattern]) => pattern instanceof RegExp && pattern.source === '\\r?\\n\\r?\\n'
    )
    expect(usedSeparatorMatch).toBe(false)
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
    expect(glabExecFileAsyncMock).toHaveBeenCalledWith(['auth', 'status'], { timeout: 10_000 })
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

  it('coalesces many simultaneous callers in one execution context', async () => {
    let resolveProbe!: (value: { stdout: string; stderr: string }) => void
    glabExecFileAsyncMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveProbe = resolve
        })
    )

    const probes = Array.from({ length: 64 }, () => getGlabKnownHosts())

    expect(glabExecFileAsyncMock).toHaveBeenCalledTimes(1)
    resolveProbe({ stdout: 'Logged in to gitlab.concurrent.test as user\n', stderr: '' })
    const results = await Promise.all(probes)
    expect(results.every((result) => result === results[0])).toBe(true)
    expect(results[0]).toEqual(['gitlab.com', 'gitlab.concurrent.test'])
  })

  it('keeps simultaneous native, WSL distro, and connection probes isolated', async () => {
    glabExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'Logged in to ubuntu.test as user\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'Logged in to debian.test as user\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'Logged in to native.test as user\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'Logged in to ssh.test as user\n', stderr: '' })

    const [ubuntu, ubuntuAgain, debian, native, ssh] = await Promise.all([
      getGlabKnownHosts(undefined, { wslDistro: 'Ubuntu' }),
      getGlabKnownHosts(undefined, { wslDistro: 'Ubuntu' }),
      getGlabKnownHosts(undefined, { wslDistro: 'Debian' }),
      getGlabKnownHosts(),
      getGlabKnownHosts('conn-1')
    ])

    expect(ubuntuAgain).toBe(ubuntu)
    expect(ubuntu).toEqual(['gitlab.com', 'ubuntu.test'])
    expect(debian).toEqual(['gitlab.com', 'debian.test'])
    expect(native).toEqual(['gitlab.com', 'native.test'])
    expect(ssh).toEqual(['gitlab.com', 'ssh.test'])
    expect(glabExecFileAsyncMock).toHaveBeenCalledTimes(4)
    expect(glabExecFileAsyncMock).toHaveBeenNthCalledWith(1, ['auth', 'status'], {
      timeout: 10_000,
      wslDistro: 'Ubuntu'
    })
    expect(glabExecFileAsyncMock).toHaveBeenNthCalledWith(2, ['auth', 'status'], {
      timeout: 10_000,
      wslDistro: 'Debian'
    })
  })

  it('recognizes a self-hosted host on a non-default port', async () => {
    glabExecFileAsyncMock.mockResolvedValueOnce({
      stdout: '✓ Logged in to gitlab.example.com:8080 as user\n',
      stderr: ''
    })

    await expect(getGlabKnownHosts()).resolves.toEqual(['gitlab.com', 'gitlab.example.com:8080'])
  })

  it('caches per connection — the local probe does not satisfy a connection probe', async () => {
    glabExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '✓ Logged in to gitlab.com as user\n', stderr: '' })
      .mockResolvedValueOnce({
        stdout: '✓ Logged in to gitlab.example.com:8080 as user\n',
        stderr: ''
      })

    await expect(getGlabKnownHosts()).resolves.toEqual(['gitlab.com'])
    await expect(getGlabKnownHosts('conn-1')).resolves.toEqual([
      'gitlab.com',
      'gitlab.example.com:8080'
    ])
    // A second probe for the same connection is served from cache.
    await expect(getGlabKnownHosts('conn-1')).resolves.toEqual([
      'gitlab.com',
      'gitlab.example.com:8080'
    ])
    expect(glabExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('does not permanently cache the failure fallback — a later probe can re-discover hosts', async () => {
    glabExecFileAsyncMock
      .mockRejectedValueOnce(new Error('ssh tunnel not ready'))
      .mockResolvedValueOnce({
        stdout: '✓ Logged in to gitlab.example.com:8080 as user\n',
        stderr: ''
      })

    // First probe fails → canonical default, NOT cached.
    await expect(getGlabKnownHosts('conn-1')).resolves.toEqual(['gitlab.com'])
    // Re-probe (e.g. after tunnel comes up) discovers the real host.
    await expect(getGlabKnownHosts('conn-1')).resolves.toEqual([
      'gitlab.com',
      'gitlab.example.com:8080'
    ])
    expect(glabExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('removes a timed-out probe from in-flight state so a later call retries', async () => {
    let rejectProbe!: (error: Error) => void
    glabExecFileAsyncMock
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectProbe = reject
          })
      )
      .mockResolvedValueOnce({ stdout: 'Logged in to recovered.test as user\n', stderr: '' })

    const first = getGlabKnownHosts(undefined, { wslDistro: 'Ubuntu' })
    const concurrent = getGlabKnownHosts(undefined, { wslDistro: 'Ubuntu' })
    expect(glabExecFileAsyncMock).toHaveBeenCalledTimes(1)
    rejectProbe(new Error('wsl.exe timed out.'))

    await expect(Promise.all([first, concurrent])).resolves.toEqual([
      ['gitlab.com'],
      ['gitlab.com']
    ])
    await expect(getGlabKnownHosts(undefined, { wslDistro: 'Ubuntu' })).resolves.toEqual([
      'gitlab.com',
      'recovered.test'
    ])
    expect(glabExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('does not reuse a successful result after an SSH provider reconnects', async () => {
    const connectionId = 'conn-reconnected'
    registerSshGitProvider(connectionId, {} as never)
    glabExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'Logged in to old-tunnel.test as user\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'Logged in to new-tunnel.test as user\n', stderr: '' })

    await expect(getGlabKnownHosts(connectionId)).resolves.toEqual([
      'gitlab.com',
      'old-tunnel.test'
    ])
    registerSshGitProvider(connectionId, {} as never)
    await expect(getGlabKnownHosts(connectionId)).resolves.toEqual([
      'gitlab.com',
      'new-tunnel.test'
    ])
    expect(glabExecFileAsyncMock).toHaveBeenCalledTimes(2)
    unregisterSshGitProvider(connectionId)
  })
})
