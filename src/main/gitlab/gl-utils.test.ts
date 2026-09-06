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
  _resetProjectRefCache,
  classifyGlabError,
  classifyJobLogError,
  classifyListFetchError,
  classifyListIssuesError,
  acquire,
  release,
  GITLAB_ADMISSION_TIMEOUT_MS,
  getIssueProjectRef,
  parseGlabJsonList,
  parseGlabPaginationHeader,
  isMissingJobLogError,
  getProjectRef,
  getProjectRefForRemote,
  parseGlabApiResponse,
  parseGlabAuthStatusHosts,
  resolveIssueSource
} from './gl-utils'
import { GlabNonListResponseError } from './glab-api-response'
import { registerSshGitProvider, unregisterSshGitProvider } from '../providers/ssh-git-dispatch'
import { REMOTE_URL_PROBE_TIMEOUT_MS } from '../git/remote-url-probe'
import { NEGATIVE_ENTRY_TTL_MS } from '../git/remote-ref-probe-cache'

describe('gitlab project ref resolution', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    glabExecFileAsyncMock.mockReset()
    sshExecMock.mockReset()
    unregisterSshGitProvider('conn-1')
    _resetProjectRefCache()
  })

  afterEach(() => {
    vi.useRealTimers()
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
      cwd: '/repo',
      timeout: REMOTE_URL_PROBE_TIMEOUT_MS
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
      cwd: '/repo',
      timeout: REMOTE_URL_PROBE_TIMEOUT_MS
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
      cwd: '/repo',
      timeout: REMOTE_URL_PROBE_TIMEOUT_MS
    })
    expect(gitExecFileAsyncMock).toHaveBeenNthCalledWith(2, ['remote', 'get-url', 'origin'], {
      cwd: '/repo',
      wslDistro: 'Ubuntu',
      timeout: REMOTE_URL_PROBE_TIMEOUT_MS
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
      cwd: '/repo',
      timeout: REMOTE_URL_PROBE_TIMEOUT_MS
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

    expect(sshExecMock).toHaveBeenCalledWith(['remote', 'get-url', 'origin'], '/repo', {
      signal: expect.any(AbortSignal)
    })
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

  it('does not cache a local probe killed on its deadline as a definitive miss', async () => {
    gitExecFileAsyncMock
      .mockRejectedValueOnce(new Error('git timed out.'))
      .mockResolvedValueOnce({ stdout: 'git@gitlab.com:fork/orca.git\n' })

    await expect(getProjectRef('/repo')).resolves.toBeNull()
    await expect(getProjectRef('/repo')).resolves.toEqual({
      host: 'gitlab.com',
      path: 'fork/orca'
    })
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('re-probes a repo whose GitLab remote could have been added since the miss', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    gitExecFileAsyncMock.mockRejectedValueOnce(new Error("error: No such remote 'origin'"))

    await expect(getProjectRef('/repo')).resolves.toBeNull()
    await expect(getProjectRef('/repo')).resolves.toBeNull()
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)

    // Nothing watches `.git/config`, and SSH/WSL repos have no file to watch, so
    // a remote configured after the miss is only visible once the negative ages out.
    gitExecFileAsyncMock.mockResolvedValue({ stdout: 'git@gitlab.com:fork/orca.git\n' })
    vi.setSystemTime(1_000_000 + NEGATIVE_ENTRY_TTL_MS + 1)

    await expect(getProjectRef('/repo')).resolves.toEqual({
      host: 'gitlab.com',
      path: 'fork/orca'
    })
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('keeps a resolved project ref past the negative interval', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    gitExecFileAsyncMock.mockResolvedValue({ stdout: 'git@gitlab.com:fork/orca.git\n' })

    await expect(getProjectRef('/repo')).resolves.toEqual({
      host: 'gitlab.com',
      path: 'fork/orca'
    })
    vi.setSystemTime(1_000_000 + NEGATIVE_ENTRY_TTL_MS * 10)
    await expect(getProjectRef('/repo')).resolves.toEqual({
      host: 'gitlab.com',
      path: 'fork/orca'
    })

    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('re-resolves a self-hosted remote once glab auth knows its host', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: 'git@gitlab.internal:team/orca.git\n' })
    glabExecFileAsyncMock.mockRejectedValue(new Error('not authenticated'))

    await expect(getProjectRefForRemote('/repo', 'origin', ['gitlab.com'])).resolves.toBeNull()
    await expect(
      getProjectRefForRemote('/repo', 'origin', ['gitlab.com', 'gitlab.internal'])
    ).resolves.toEqual({ host: 'gitlab.internal', path: 'team/orca' })
  })

  it('asks glab about an unauthenticated host once per interval, not once per repo', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    gitExecFileAsyncMock.mockResolvedValue({ stdout: 'git@github.com:team/orca.git\n' })
    glabExecFileAsyncMock.mockRejectedValue(new Error('not authenticated'))

    // Expiring project-ref negatives must not turn the hosted-review poll into a
    // `glab auth status` spawn per repo per interval — the answer is per host.
    for (const repoPath of ['/repo-a', '/repo-b', '/repo-c']) {
      await expect(getProjectRef(repoPath)).resolves.toBeNull()
    }
    expect(glabExecFileAsyncMock).toHaveBeenCalledTimes(1)

    vi.setSystemTime(1_000_000 + NEGATIVE_ENTRY_TTL_MS + 1)
    for (const repoPath of ['/repo-a', '/repo-b', '/repo-c']) {
      await expect(getProjectRef(repoPath)).resolves.toBeNull()
    }
    expect(glabExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('does not serve a project ref resolved on a retired SSH connection', async () => {
    sshExecMock
      .mockResolvedValueOnce({ stdout: 'git@gitlab.com:before/orca.git\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'git@gitlab.com:after/orca.git\n', stderr: '' })
    registerSshGitProvider('conn-1', { exec: sshExecMock } as never)

    await expect(getProjectRefForRemote('/repo', 'origin', undefined, 'conn-1')).resolves.toEqual({
      host: 'gitlab.com',
      path: 'before/orca'
    })

    // A reconnect can swap the execution host under the same connection id.
    unregisterSshGitProvider('conn-1')
    registerSshGitProvider('conn-1', { exec: sshExecMock } as never)

    await expect(getProjectRefForRemote('/repo', 'origin', undefined, 'conn-1')).resolves.toEqual({
      host: 'gitlab.com',
      path: 'after/orca'
    })
    expect(sshExecMock).toHaveBeenCalledTimes(2)
  })
})

describe('GitLab operation admission', () => {
  afterEach(() => {
    vi.useRealTimers()
    // Drain any slots held by the saturation test before the next test.
    for (let i = 0; i < 4; i += 1) {
      release()
    }
  })

  it('expires queued work instead of retaining it behind saturated operations', async () => {
    vi.useFakeTimers()
    await Promise.all(Array.from({ length: 4 }, () => acquire()))

    const queued = acquire()
    const rejection = expect(queued).rejects.toThrow(
      'Timed out waiting for a GitLab operation slot.'
    )
    await vi.advanceTimersByTimeAsync(GITLAB_ADMISSION_TIMEOUT_MS)
    await rejection

    release()
    await expect(acquire()).resolves.toBeUndefined()
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
      cwd: '/repo',
      timeout: REMOTE_URL_PROBE_TIMEOUT_MS
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

  it('rewrites issue-edit copy for job logs via classifyJobLogError', () => {
    expect(classifyJobLogError('HTTP 403').message).toMatch(/permission to read this job's log/i)
    expect(classifyJobLogError('HTTP 403').message).not.toMatch(/issue/i)
    expect(classifyJobLogError('boom').message).toBe('Failed to load the job log: boom')
  })

  it('treats a 404 job log as missing, but keeps a missing project an error', () => {
    expect(isMissingJobLogError('HTTP 404 Not Found')).toBe(true)
    expect(isMissingJobLogError('HTTP 404: Project Not Found')).toBe(false)
    expect(isMissingJobLogError('HTTP 403 Forbidden')).toBe(false)
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

describe('parseGlabJsonList', () => {
  it('returns the parsed list unchanged', () => {
    expect(parseGlabJsonList<{ iid: number }>('[{"iid":1}]')).toEqual([{ iid: 1 }])
  })

  it.each([
    ['null', 'null'],
    ['a number', '0'],
    ['a string', '"nope"'],
    ['an object', '{"data":[]}']
  ])('reports the raw payload for %s as an unclassifiable body', (_label, payload) => {
    expect(() => parseGlabJsonList(payload)).toThrow(GlabNonListResponseError)
    expect(() => parseGlabJsonList(payload)).toThrow(payload)
  })

  // Why: glab allows a 10MB body, and the renderer's error banner has no length guard of its own.
  it.each([
    ['an opaque body', `{"data":"${'x'.repeat(50_000)}"}`],
    ['an error envelope', `{"message":"${'x'.repeat(50_000)}"}`]
  ])('bounds the reported payload for %s', (_label, payload) => {
    expect(() => parseGlabJsonList(payload)).toThrow(
      /^GitLab returned (?:a non-list response|an error): .{300}$/
    )
  })

  it.each([
    ['message', '{"message":"403 Forbidden"}', '403 Forbidden'],
    ['error', '{"error":"insufficient_scope"}', 'insufficient_scope'],
    ['error when message is blank', '{"message":"  ","error":"real_error"}', 'real_error'],
    // Why: GitLab sends both on some endpoints; `message` is the human-facing one.
    [
      'message when both are set',
      '{"message":"404 Project Not Found","error":"insufficient_scope"}',
      '404 Project Not Found'
    ]
  ])('reports a GitLab error envelope by its %s field', (_label, payload, reported) => {
    // Why: an envelope is GitLab's own diagnostic, so it stays classifiable — unlike a raw body.
    expect(() => parseGlabJsonList(payload)).toThrow(`GitLab returned an error: ${reported}`)
    expect(() => parseGlabJsonList(payload)).not.toThrow(GlabNonListResponseError)
  })
})

describe('classifyListFetchError', () => {
  it('keeps opaque payload text away from the classifier', () => {
    // Why: the title would otherwise substring-match as a network failure and replace the payload.
    const payload = '{"data":[{"title":"fix network timeout"}]}'
    let thrown: unknown
    try {
      parseGlabJsonList(payload)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(GlabNonListResponseError)
    const classified = classifyListFetchError(thrown)
    expect(classified.type).toBe('unknown')
    expect(classified.message).toContain('fix network timeout')
  })

  it('still classifies ordinary glab failures by their stderr', () => {
    expect(classifyListFetchError(new Error('HTTP 403 Forbidden')).type).toBe('permission_denied')
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

describe('parseGlabPaginationHeader', () => {
  it('reads a usable header value', () => {
    expect(parseGlabPaginationHeader('25', 1)).toBe(25)
    expect(parseGlabPaginationHeader(' 9 ', 1)).toBe(9)
  })

  it('returns undefined for an absent or unparseable header', () => {
    expect(parseGlabPaginationHeader(undefined, 0)).toBeUndefined()
    expect(parseGlabPaginationHeader('', 0)).toBeUndefined()
    expect(parseGlabPaginationHeader('abc', 0)).toBeUndefined()
  })

  // Why: the minimum is what lets issues.ts tell "x-total: 0" (derive one page) apart from an
  // absent header (probe for a next page), and what makes x-total-pages: 0 fall through.
  it('rejects values below the minimum', () => {
    expect(parseGlabPaginationHeader('0', 1)).toBeUndefined()
    expect(parseGlabPaginationHeader('0', 0)).toBe(0)
    expect(parseGlabPaginationHeader('-3', 0)).toBeUndefined()
  })
})
