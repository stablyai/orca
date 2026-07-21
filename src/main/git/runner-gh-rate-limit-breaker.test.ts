import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock, execFileSyncMock, spawnMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  execFileSyncMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('child_process', () => ({
  execFile: execFileMock,
  execFileSync: execFileSyncMock,
  spawn: spawnMock
}))

import { ghExecFileAsync } from './runner'
import {
  _resetGhRateLimitBreaker,
  getGhRateLimitBlockedUntilMs,
  registerGhRateLimitResetProbe
} from './gh-rate-limit-breaker'

const PRIMARY_RATE_LIMIT_STDERR =
  'gh: API rate limit exceeded for user ID 1775218. Please wait. (HTTP 403)'

function mockGhFailure(stderr: string): void {
  execFileMock.mockImplementation((_binary, _args, options, callback) => {
    const done = typeof options === 'function' ? options : callback
    queueMicrotask(() =>
      done(Object.assign(new Error(`Command failed: gh\n${stderr}`), { stderr }), '', stderr)
    )
    return { once: vi.fn() }
  })
}

function mockGhSuccess(stdout: string): void {
  execFileMock.mockImplementation((_binary, _args, options, callback) => {
    const done = typeof options === 'function' ? options : callback
    queueMicrotask(() => done(null, stdout, ''))
    return { once: vi.fn() }
  })
}

beforeEach(() => {
  execFileMock.mockReset()
})

afterEach(() => {
  _resetGhRateLimitBreaker()
})

describe('ghExecFileAsync rate-limit breaker', () => {
  it('spawns once for a primary 403, then short-circuits same-bucket calls', async () => {
    mockGhFailure(PRIMARY_RATE_LIMIT_STDERR)
    await expect(
      ghExecFileAsync(['api', '--cache', '120s', 'search/issues?q=repo:a/b&per_page=1'])
    ).rejects.toThrow('rate limit')
    expect(execFileMock).toHaveBeenCalledTimes(1)

    // The 90-repo storm case: every further search-bucket call must fail fast
    // without a subprocess.
    await expect(
      ghExecFileAsync(['api', '--cache', '120s', 'search/issues?q=repo:c/d&per_page=1'])
    ).rejects.toMatchObject({ ghRateLimitBlocked: true })
    expect(execFileMock).toHaveBeenCalledTimes(1)
  })

  it('keeps other buckets working while one bucket is blocked', async () => {
    mockGhFailure(PRIMARY_RATE_LIMIT_STDERR)
    await expect(ghExecFileAsync(['api', 'search/issues?q=x'])).rejects.toThrow()
    mockGhSuccess('[]')
    await expect(ghExecFileAsync(['pr', 'list', '--limit', '36'])).resolves.toEqual({
      stdout: '[]',
      stderr: ''
    })
    expect(execFileMock).toHaveBeenCalledTimes(2)
  })

  it('keeps other GitHub hosts and WSL runtimes working when github.com is blocked', async () => {
    mockGhFailure(PRIMARY_RATE_LIMIT_STDERR)
    await expect(ghExecFileAsync(['api', 'repos/a/b/pulls'])).rejects.toThrow()

    // The breaker scope now comes from options.host / GH_HOST / wslDistro, not
    // from sniffing argv — so an Enterprise host must be routed via options.host.
    mockGhSuccess('[]')
    await expect(
      ghExecFileAsync(['api', 'repos/a/b/pulls'], { host: 'github.acme-corp.com' })
    ).resolves.toMatchObject({ stdout: '[]' })
    await expect(
      ghExecFileAsync(['pr', 'list', '--repo', 'a/b'], { host: 'github.acme-corp.com' })
    ).resolves.toMatchObject({ stdout: '[]' })
    await expect(
      ghExecFileAsync(['api', 'repos/a/b/pulls'], {
        env: { ...process.env, GH_HOST: 'github.acme-corp.com' }
      })
    ).resolves.toMatchObject({ stdout: '[]' })
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      await expect(
        ghExecFileAsync(['api', 'repos/a/b/pulls'], { wslDistro: 'Ubuntu' })
      ).resolves.toMatchObject({ stdout: '[]' })
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
    }
    expect(execFileMock).toHaveBeenCalledTimes(5)
  })

  it.each([
    ['separate', ['--hostname', 'github.com']],
    ['inline', ['--hostname=github.com']]
  ])('scopes an explicit %s hostname ahead of process GH_HOST', async (_name, hostnameArgs) => {
    const originalGhHost = process.env.GH_HOST
    process.env.GH_HOST = 'github.acme-corp.com'
    try {
      mockGhFailure(PRIMARY_RATE_LIMIT_STDERR)
      await expect(ghExecFileAsync(['api', ...hostnameArgs, 'repos/a/b/pulls'])).rejects.toThrow(
        'rate limit'
      )

      expect(getGhRateLimitBlockedUntilMs('core', Date.now(), 'native:github.com')).not.toBeNull()
      expect(
        getGhRateLimitBlockedUntilMs('core', Date.now(), 'native:github.acme-corp.com')
      ).toBeNull()

      mockGhSuccess('[]')
      await expect(ghExecFileAsync(['api', 'repos/a/b/pulls'])).resolves.toMatchObject({
        stdout: '[]'
      })
    } finally {
      if (originalGhHost === undefined) {
        delete process.env.GH_HOST
      } else {
        process.env.GH_HOST = originalGhHost
      }
    }
  })

  it.each([
    ['--repo', ['pr', 'list', '--repo', 'github.acme-corp.com/acme/widgets']],
    ['-R', ['pr', 'list', '-R', 'github.acme-corp.com/acme/widgets']],
    ['--repo=', ['pr', 'list', '--repo=github.acme-corp.com/acme/widgets']]
  ])('scopes a pre-qualified %s value to its repository host', async (_name, args) => {
    mockGhFailure(PRIMARY_RATE_LIMIT_STDERR)

    await expect(
      ghExecFileAsync(args, { env: { ...process.env, GH_HOST: 'github.com' } })
    ).rejects.toThrow('rate limit')

    expect(
      getGhRateLimitBlockedUntilMs('core', Date.now(), 'native:github.acme-corp.com')
    ).not.toBeNull()
    expect(getGhRateLimitBlockedUntilMs('core', Date.now(), 'native:github.com')).toBeNull()
  })

  it('scopes a WSL UNC-cwd 403 to the distro runtime and probes that scope', async () => {
    // Why: a \\wsl.localhost\... cwd routes gh through wsl.exe, so the 403
    // belongs to the distro's account — the native scope must stay usable and
    // the reset probe must be told which scope tripped.
    const probe = vi.fn()
    registerGhRateLimitResetProbe(probe)
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      mockGhFailure(PRIMARY_RATE_LIMIT_STDERR)
      await expect(
        ghExecFileAsync(['api', 'repos/a/b/pulls'], {
          cwd: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'
        })
      ).rejects.toThrow()

      expect(probe).toHaveBeenCalledWith('core', 'wsl:ubuntu:github.com')
      expect(
        getGhRateLimitBlockedUntilMs('core', Date.now(), 'wsl:ubuntu:github.com')
      ).not.toBeNull()
      expect(getGhRateLimitBlockedUntilMs('core', Date.now())).toBeNull()

      mockGhSuccess('[]')
      await expect(ghExecFileAsync(['api', 'repos/a/b/pulls'])).resolves.toMatchObject({
        stdout: '[]'
      })
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('never blocks the exempt rate_limit probe', async () => {
    mockGhFailure(PRIMARY_RATE_LIMIT_STDERR)
    await expect(ghExecFileAsync(['api', 'repos/a/b/pulls'])).rejects.toThrow()
    mockGhSuccess('{"resources":{}}')
    await expect(
      ghExecFileAsync(['api', '--hostname', 'github.com', 'rate_limit'])
    ).resolves.toMatchObject({
      stdout: '{"resources":{}}'
    })
    expect(execFileMock).toHaveBeenCalledTimes(2)
  })

  it('does not trip the breaker on secondary rate limits', async () => {
    mockGhFailure('gh: You have exceeded a secondary rate limit. (HTTP 403)')
    await expect(
      ghExecFileAsync(['api', 'repos/a/b/pulls'], { idempotent: false })
    ).rejects.toThrow()
    mockGhSuccess('[]')
    await expect(ghExecFileAsync(['api', 'repos/a/b/pulls'])).resolves.toEqual({
      stdout: '[]',
      stderr: ''
    })
  })
})
