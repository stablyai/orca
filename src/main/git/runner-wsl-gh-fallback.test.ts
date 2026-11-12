import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as BackgroundDistroGate from '../wsl/discovery/wsl-background-distro-gate'
import { fakeSpawnDispatch, fakeSpawnReturning } from '../../shared/__fixtures__/fake-spawned-child'
import type * as WslModule from '../wsl/discovery/distro-catalog'

const { execFileSyncMock, spawnMock, getDefaultWslDistroMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  spawnMock: vi.fn(),
  getDefaultWslDistroMock: vi.fn()
}))

// The default-distro fallback asks whether the distro runs before it may start it (E9).
vi.mock('../wsl/discovery/wsl-background-distro-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof BackgroundDistroGate>()),
  readWslDistroRunningState: vi.fn(async () => 'running')
}))

vi.mock('child_process', () => ({
  execFile: vi.fn(),
  execFileSync: execFileSyncMock,
  spawn: spawnMock
}))

vi.mock('../wsl/discovery/distro-catalog', async (importOriginal) => ({
  ...(await importOriginal<typeof WslModule>()),
  getDefaultWslDistro: getDefaultWslDistroMock
}))
import { ghExecFileAsync } from './command-runner/hosted-cli/gh-exec-file'
import { glabExecFileAsync } from './command-runner/hosted-cli/glab-exec-file'
import { setDefaultWslDistroOverride } from './command-runner/host-routing/wsl-command-resolution'
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

  it('does not fall back for repo-context gh calls without explicit repo context', async () => {
    spawnMock.mockImplementation(fakeSpawnReturning({ stderr: WSL_GH_MISSING, code: 1 }))

    await expect(
      ghExecFileAsync(['issue', 'list'], {
        cwd: String.raw`\\wsl.localhost\Ubuntu\home\jinwoo\stably\noqa`
      })
    ).rejects.toThrow('gh: command not found')

    expect(spawnMock).toHaveBeenCalledTimes(1)
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
})
