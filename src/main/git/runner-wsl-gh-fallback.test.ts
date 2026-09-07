import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createFakeSpawnedChild,
  fakeSpawnDispatch,
  fakeSpawnReturning
} from '../../shared/child-process/__fixtures__/fake-spawned-child'
import type * as WslModule from '../wsl'

const { execFileSyncMock, spawnMock, getDefaultWslDistroMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  spawnMock: vi.fn(),
  getDefaultWslDistroMock: vi.fn()
}))

vi.mock('child_process', () => ({
  execFile: vi.fn(),
  execFileSync: execFileSyncMock,
  spawn: spawnMock
}))

vi.mock('../wsl', async (importOriginal) => ({
  ...(await importOriginal<typeof WslModule>()),
  getDefaultWslDistro: getDefaultWslDistroMock
}))

import { ghExecFileAsync, glabExecFileAsync, setDefaultWslDistroOverride } from './runner'
import { _resetGhRateLimitBreaker } from './gh-rate-limit-breaker'

const PRIMARY_RATE_LIMIT_STDERR =
  'gh: API rate limit exceeded for user ID 1775218. Please wait. (HTTP 403)'

// What the distro prints when the CLI is absent inside WSL but present on the host.
const WSL_GH_MISSING = 'bash: line 1: gh: command not found\n'
const TRANSIENT_502 = 'HTTP 502 Bad Gateway'

function spawnEnoent(command: string): { spawnError: Error } {
  return { spawnError: Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT' }) }
}

describe('ghExecFileAsync WSL fallback', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    spawnMock.mockReset()
    getDefaultWslDistroMock.mockReset()
    getDefaultWslDistroMock.mockReturnValue(null)
    setDefaultWslDistroOverride(null)
    _resetGhRateLimitBreaker()
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    _resetGhRateLimitBreaker()
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: originalPlatform
    })
  })

  it('falls back to host gh for explicit-repo WSL calls when gh is missing in the distro', async () => {
    spawnMock.mockImplementation(
      fakeSpawnDispatch((program) =>
        program === 'wsl.exe' ? { stderr: WSL_GH_MISSING, code: 1 } : { stdout: '[]' }
      )
    )

    await expect(
      ghExecFileAsync(['issue', 'list', '--repo', 'stablyhq/noqa', '--json', 'number,title'], {
        cwd: String.raw`\\wsl.localhost\Ubuntu\home\jinwoo\stably\noqa`
      })
    ).resolves.toEqual({ stdout: '[]', stderr: '' })

    expect(spawnMock).toHaveBeenNthCalledWith(
      1,
      'wsl.exe',
      [
        '-d',
        'Ubuntu',
        '--exec',
        'bash',
        '-c',
        "cd '/home/jinwoo/stably/noqa' && 'gh' 'issue' 'list' '--repo' 'stablyhq/noqa' '--json' 'number,title'"
      ],
      // Why a concrete directory (#16463): `undefined` makes CreateProcessW inherit
      // Orca's own cwd, a deletable WSL UNC path when it was launched from a
      // worktree. The Linux directory still rides inside the command.
      expect.objectContaining({ cwd: expect.any(String) })
    )
    expect(spawnMock).toHaveBeenNthCalledWith(
      2,
      'gh',
      ['issue', 'list', '--repo', 'stablyhq/noqa', '--json', 'number,title'],
      expect.objectContaining({ cwd: undefined })
    )
  })

  it('does not fall back for repo-context gh calls without explicit repo context', async () => {
    spawnMock.mockImplementation(fakeSpawnReturning({ stderr: WSL_GH_MISSING, code: 1 }))

    await expect(
      ghExecFileAsync(['issue', 'list'], {
        cwd: String.raw`\\wsl.localhost\Ubuntu\home\jinwoo\stably\noqa`
      })
    ).rejects.toThrow('gh: command not found')

    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('falls back for short-form explicit repo flags used by gh', async () => {
    spawnMock.mockImplementation(
      fakeSpawnDispatch((program) =>
        program === 'wsl.exe' ? { stderr: WSL_GH_MISSING, code: 1 } : { stdout: '[]' }
      )
    )

    await expect(
      ghExecFileAsync(['issue', 'list', '-R', 'stablyhq/noqa'], {
        cwd: String.raw`\\wsl.localhost\Ubuntu\home\jinwoo\stably\noqa`
      })
    ).resolves.toEqual({ stdout: '[]', stderr: '' })

    expect(spawnMock).toHaveBeenNthCalledWith(
      2,
      'gh',
      ['issue', 'list', '-R', 'stablyhq/noqa'],
      expect.objectContaining({ cwd: undefined })
    )
  })

  it('falls back for compact short-form repo flags used by gh', async () => {
    spawnMock.mockImplementation(
      fakeSpawnDispatch((program) =>
        program === 'wsl.exe' ? { stderr: WSL_GH_MISSING, code: 1 } : { stdout: '[]' }
      )
    )

    await expect(
      ghExecFileAsync(['issue', 'list', '-Rstablyhq/noqa'], {
        cwd: String.raw`\\wsl.localhost\Ubuntu\home\jinwoo\stably\noqa`
      })
    ).resolves.toEqual({ stdout: '[]', stderr: '' })

    expect(spawnMock).toHaveBeenNthCalledWith(
      2,
      'gh',
      ['issue', 'list', '-Rstablyhq/noqa'],
      expect.objectContaining({ cwd: undefined })
    )
  })

  it('falls back for repo view with an explicit positional repository', async () => {
    spawnMock.mockImplementation(
      fakeSpawnDispatch((program) =>
        program === 'wsl.exe' ? { stderr: WSL_GH_MISSING, code: 1 } : { stdout: '{"isFork":false}' }
      )
    )

    await expect(
      ghExecFileAsync(
        ['repo', 'view', 'github.acme-corp.com/stablyhq/noqa', '--json', 'isFork,parent'],
        {
          cwd: String.raw`\\wsl.localhost\Ubuntu\home\jinwoo\stably\noqa`,
          host: 'github.acme-corp.com'
        }
      )
    ).resolves.toEqual({ stdout: '{"isFork":false}', stderr: '' })

    expect(spawnMock).toHaveBeenNthCalledWith(
      2,
      'gh',
      ['repo', 'view', 'github.acme-corp.com/stablyhq/noqa', '--json', 'isFork,parent'],
      expect.objectContaining({ cwd: undefined })
    )
  })

  it('does not fall back for gh api calls that depend on repo-context placeholders', async () => {
    spawnMock.mockImplementation(fakeSpawnReturning({ stderr: WSL_GH_MISSING, code: 1 }))

    await expect(
      ghExecFileAsync(['api', 'repos/stablyhq/noqa/branches/{branch}'], {
        cwd: String.raw`\\wsl.localhost\Ubuntu\home\jinwoo\stably\noqa`
      })
    ).rejects.toThrow('gh: command not found')

    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('retries idempotent gh GraphQL query transient failures', async () => {
    spawnMock
      .mockImplementationOnce(fakeSpawnReturning({ stderr: TRANSIENT_502, code: 1 }))
      .mockImplementationOnce(fakeSpawnReturning({ stdout: '{"data":{}}' }))

    await expect(
      ghExecFileAsync(['api', 'graphql', '-f', 'query=query { viewer { login } }'])
    ).resolves.toEqual({ stdout: '{"data":{}}', stderr: '' })

    expect(spawnMock).toHaveBeenCalledTimes(2)
  })

  it('retries a host-pinned idempotent gh GraphQL query after host injection', async () => {
    spawnMock
      .mockImplementationOnce(fakeSpawnReturning({ stderr: TRANSIENT_502, code: 1 }))
      .mockImplementationOnce(fakeSpawnReturning({ stdout: '{"data":{}}' }))

    await expect(
      ghExecFileAsync(['api', 'graphql', '-f', 'query=query { viewer { login } }'], {
        host: 'github.acme-corp.com'
      })
    ).resolves.toEqual({ stdout: '{"data":{}}', stderr: '' })

    expect(spawnMock).toHaveBeenCalledTimes(2)
    expect(spawnMock).toHaveBeenNthCalledWith(
      1,
      'gh',
      [
        'api',
        '--hostname',
        'github.acme-corp.com',
        'graphql',
        '-f',
        'query=query { viewer { login } }'
      ],
      expect.any(Object)
    )
  })

  it('does not retry non-idempotent gh API transient failures', async () => {
    spawnMock.mockImplementation(fakeSpawnReturning({ stderr: TRANSIENT_502, code: 1 }))

    await expect(
      ghExecFileAsync(['api', '-X', 'POST', 'repos/stablyai/orca/issues'])
    ).rejects.toThrow('HTTP 502 Bad Gateway')

    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('does not retry gh GraphQL mutation transient failures', async () => {
    spawnMock.mockImplementation(fakeSpawnReturning({ stderr: TRANSIENT_502, code: 1 }))

    await expect(
      ghExecFileAsync([
        'api',
        'graphql',
        '-f',
        'query=mutation { addStar(input: {}) { starrable { id } } }'
      ])
    ).rejects.toThrow('HTTP 502 Bad Gateway')

    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('does not retry high-level gh edit transient failures', async () => {
    spawnMock.mockImplementation(fakeSpawnReturning({ stderr: TRANSIENT_502, code: 1 }))

    await expect(
      ghExecFileAsync(['issue', 'edit', '5', '--repo', 'stablyai/orca'])
    ).rejects.toThrow('HTTP 502 Bad Gateway')

    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('retries cwd-less gh calls through the default WSL distro when host gh is missing', async () => {
    getDefaultWslDistroMock.mockReturnValue('Ubuntu')
    spawnMock
      .mockImplementationOnce(fakeSpawnReturning(spawnEnoent('gh')))
      .mockImplementationOnce(fakeSpawnReturning({ stdout: '{"resources":{}}' }))

    await expect(ghExecFileAsync(['api', 'rate_limit'])).resolves.toEqual({
      stdout: '{"resources":{}}',
      stderr: ''
    })

    expect(spawnMock).toHaveBeenNthCalledWith(
      2,
      'wsl.exe',
      ['-d', 'Ubuntu', '--exec', 'bash', '-c', "'gh' 'api' 'rate_limit'"],
      // Why a concrete directory (#16463): `undefined` makes CreateProcessW inherit
      // Orca's own cwd, a deletable WSL UNC path when it was launched from a
      // worktree. This global call has no repo directory at all, so nothing about
      // where it runs changes.
      expect.objectContaining({ cwd: expect.any(String) })
    )
  })

  it('checks a blocked WSL scope before repeating a native-to-WSL fallback', async () => {
    getDefaultWslDistroMock.mockReturnValue('Ubuntu')
    spawnMock.mockImplementation(
      fakeSpawnDispatch((program) =>
        program === 'gh' ? spawnEnoent('gh') : { stderr: PRIMARY_RATE_LIMIT_STDERR, code: 1 }
      )
    )

    await expect(ghExecFileAsync(['api', 'repos/acme/widgets/pulls'])).rejects.toThrow('rate limit')
    await expect(ghExecFileAsync(['api', 'repos/acme/widgets/pulls'])).rejects.toMatchObject({
      ghRateLimitBlocked: true
    })

    expect(spawnMock).toHaveBeenCalledTimes(3)
    expect(spawnMock.mock.calls.map(([binary]) => binary)).toEqual(['gh', 'wsl.exe', 'gh'])
  })

  it('checks a blocked native scope before repeating a WSL-to-native fallback', async () => {
    spawnMock.mockImplementation(
      fakeSpawnDispatch((program) =>
        program === 'wsl.exe'
          ? { stderr: WSL_GH_MISSING, code: 1 }
          : { stderr: PRIMARY_RATE_LIMIT_STDERR, code: 1 }
      )
    )

    const options = {
      cwd: String.raw`\\wsl.localhost\Ubuntu\home\jinwoo\stably\noqa`
    }
    await expect(ghExecFileAsync(['api', 'repos/acme/widgets/pulls'], options)).rejects.toThrow(
      'rate limit'
    )
    await expect(
      ghExecFileAsync(['api', 'repos/acme/widgets/pulls'], options)
    ).rejects.toMatchObject({ ghRateLimitBlocked: true })

    expect(spawnMock).toHaveBeenCalledTimes(3)
    expect(spawnMock.mock.calls.map(([binary]) => binary)).toEqual(['wsl.exe', 'gh', 'wsl.exe'])
  })

  it('does not retry non-idempotent glab transient failures', async () => {
    spawnMock.mockImplementation(fakeSpawnReturning({ stderr: TRANSIENT_502, code: 1 }))

    await expect(
      glabExecFileAsync(['api', '-X', 'POST', 'projects/stablyai%2Forca/issues/5/notes'], {
        cwd: String.raw`C:\repo`
      })
    ).rejects.toThrow('HTTP 502 Bad Gateway')

    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('does not retry high-level glab update transient failures', async () => {
    spawnMock.mockImplementation(fakeSpawnReturning({ stderr: TRANSIENT_502, code: 1 }))

    await expect(
      glabExecFileAsync(['issue', 'update', '5', '-R', 'stablyai/orca'], {
        cwd: String.raw`C:\repo`
      })
    ).rejects.toThrow('HTTP 502 Bad Gateway')

    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('retries cwd-less glab calls through the default WSL distro when host glab is missing', async () => {
    getDefaultWslDistroMock.mockReturnValue('Ubuntu')
    spawnMock
      .mockImplementationOnce(fakeSpawnReturning(spawnEnoent('glab')))
      .mockImplementationOnce(fakeSpawnReturning({ stdout: '[]' }))

    await expect(glabExecFileAsync(['api', 'projects'])).resolves.toEqual({
      stdout: '[]',
      stderr: ''
    })

    expect(spawnMock).toHaveBeenNthCalledWith(
      2,
      'wsl.exe',
      ['-d', 'Ubuntu', '--exec', 'bash', '-c', "'glab' 'api' 'projects'"],
      // Why a concrete directory (#16463): `undefined` makes CreateProcessW inherit
      // Orca's own cwd, a deletable WSL UNC path when it was launched from a
      // worktree. This global call has no repo directory at all, so nothing about
      // where it runs changes.
      expect.objectContaining({ cwd: expect.any(String) })
    )
  })

  it('times out the default-WSL glab fallback and waits for full tree cleanup', async () => {
    vi.useFakeTimers()
    getDefaultWslDistroMock.mockReturnValue('Ubuntu')
    const wslChild = createFakeSpawnedChild(2400)
    const taskkill = createFakeSpawnedChild(3600)
    spawnMock
      .mockImplementationOnce(fakeSpawnReturning(spawnEnoent('glab')))
      // Why a child that never exits: this is the wedged WSL helper the deadline
      // has to reap, so nothing must settle the promise before taskkill reports.
      .mockImplementationOnce(() => wslChild)
      .mockImplementation(() => taskkill)

    const promise = glabExecFileAsync(['auth', 'status'], { timeout: 1000 })
    const rejection = expect(promise).rejects.toThrow('wsl.exe timed out.')
    let rejected = false
    void promise.catch(() => {
      rejected = true
    })

    await vi.advanceTimersByTimeAsync(999)
    expect(spawnMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(spawnMock).toHaveBeenCalledWith(
      'taskkill',
      ['/pid', '2400', '/t', '/f'],
      expect.objectContaining({ stdio: 'ignore', windowsHide: true })
    )
    await Promise.resolve()
    expect(rejected).toBe(false)

    taskkill.emit('close', 0)
    await rejection
    expect(wslChild.kill).not.toHaveBeenCalled()
  })

  it('aborts the default-WSL glab fallback with full process-tree cleanup', async () => {
    getDefaultWslDistroMock.mockReturnValue('Ubuntu')
    const wslChild = createFakeSpawnedChild(2400)
    const taskkill = createFakeSpawnedChild(3600)
    spawnMock
      .mockImplementationOnce(fakeSpawnReturning(spawnEnoent('glab')))
      .mockImplementationOnce(() => wslChild)
      .mockImplementation(() => taskkill)
    const controller = new AbortController()

    const promise = glabExecFileAsync(['auth', 'status'], { signal: controller.signal })
    const rejection = expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2))
    controller.abort()

    expect(spawnMock).toHaveBeenNthCalledWith(
      2,
      'wsl.exe',
      ['-d', 'Ubuntu', '--exec', 'bash', '-c', "'glab' 'auth' 'status'"],
      expect.not.objectContaining({ signal: controller.signal })
    )
    expect(spawnMock).toHaveBeenCalledWith(
      'taskkill',
      ['/pid', '2400', '/t', '/f'],
      expect.objectContaining({ stdio: 'ignore', windowsHide: true })
    )
    taskkill.emit('close', 0)

    await rejection
    expect(wslChild.kill).not.toHaveBeenCalled()
  })

  it('does not wake the default WSL distro for host-only GitLab diagnostics', async () => {
    getDefaultWslDistroMock.mockReturnValue('Ubuntu')
    spawnMock
      .mockImplementationOnce(fakeSpawnReturning(spawnEnoent('glab')))
      .mockImplementationOnce(fakeSpawnReturning({ stdout: 'Logged in to gitlab.com' }))

    await expect(
      glabExecFileAsync(['auth', 'status'], { allowDefaultWslFallback: false })
    ).rejects.toThrow('spawn glab ENOENT')

    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(spawnMock).toHaveBeenCalledWith(
      'glab',
      ['auth', 'status'],
      expect.objectContaining({ cwd: undefined })
    )
  })

  it('still retries idempotent glab transient failures', async () => {
    spawnMock
      .mockImplementationOnce(fakeSpawnReturning({ stderr: TRANSIENT_502, code: 1 }))
      .mockImplementationOnce(fakeSpawnReturning({ stdout: '[]' }))

    await expect(
      glabExecFileAsync(['api', 'projects/stablyai%2Forca/issues'], {
        cwd: String.raw`C:\repo`
      })
    ).resolves.toEqual({ stdout: '[]', stderr: '' })

    expect(spawnMock).toHaveBeenCalledTimes(2)
  })

  it('resolves fallback to the overridden distro if configured, and falls back to default WSL distro otherwise', async () => {
    // 1) Test with override configured (should use 'Debian' override)
    setDefaultWslDistroOverride('Debian')
    getDefaultWslDistroMock.mockReturnValue('Ubuntu')

    spawnMock
      .mockImplementationOnce(fakeSpawnReturning(spawnEnoent('gh')))
      .mockImplementationOnce(
        fakeSpawnDispatch((program, args) =>
          program === 'wsl.exe' && args.includes('Debian')
            ? { stdout: 'Logged in to github.com as override' }
            : { stderr: 'Wrong distro fallback', code: 1 }
        )
      )

    await expect(ghExecFileAsync(['auth', 'status'])).resolves.toEqual({
      stdout: 'Logged in to github.com as override',
      stderr: ''
    })

    expect(spawnMock).toHaveBeenCalledTimes(2)
    expect(spawnMock).toHaveBeenNthCalledWith(
      2,
      'wsl.exe',
      ['-d', 'Debian', '--exec', 'bash', '-c', "'gh' 'auth' 'status'"],
      expect.any(Object)
    )

    // 2) Test without override (should use default 'Ubuntu')
    spawnMock.mockClear()
    setDefaultWslDistroOverride(null)

    spawnMock
      .mockImplementationOnce(fakeSpawnReturning(spawnEnoent('gh')))
      .mockImplementationOnce(
        fakeSpawnDispatch((program, args) =>
          program === 'wsl.exe' && args.includes('Ubuntu')
            ? { stdout: 'Logged in to github.com as default' }
            : { stderr: 'Wrong distro fallback', code: 1 }
        )
      )

    await expect(ghExecFileAsync(['auth', 'status'])).resolves.toEqual({
      stdout: 'Logged in to github.com as default',
      stderr: ''
    })

    expect(spawnMock).toHaveBeenCalledTimes(2)
    expect(spawnMock).toHaveBeenNthCalledWith(
      2,
      'wsl.exe',
      ['-d', 'Ubuntu', '--exec', 'bash', '-c', "'gh' 'auth' 'status'"],
      expect.any(Object)
    )
  })
})
