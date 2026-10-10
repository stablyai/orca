import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getOpenCodeLaunchExecutable,
  probeOpenCodeLaunchCapabilities
} from './opencode-launch-capabilities'
import { getOpenCodeCliCapabilities } from '../../shared/opencode-cli-version'

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), probe: vi.fn(), wsl: vi.fn() }))
vi.mock('../ipc/command-path-resolver', () => ({ resolveCommandOnLocalPath: mocks.resolve }))
vi.mock('./opencode-cli-version', () => ({ probeOpenCodeCliVersion: mocks.probe }))
vi.mock('../wsl/wsl-runner', () => ({ runWslProcess: mocks.wsl }))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.probe.mockResolvedValue(getOpenCodeCliCapabilities('2.0.16'))
  mocks.wsl.mockResolvedValue({
    code: 0,
    timedOut: false,
    stdout: '1.18.30',
    environmentResolved: true
  })
})

describe('OpenCode execution-host launch capability probe', () => {
  it('refuses a successful version response from an unresolved WSL execution environment', async () => {
    mocks.wsl.mockResolvedValue({
      code: 0,
      timedOut: false,
      stdout: '1.18.30',
      environmentResolved: false
    })
    await probeOpenCodeLaunchCapabilities({
      command: 'opencode',
      env: {},
      wsl: { distro: 'Ubuntu' }
    })
    expect(await mocks.probe.mock.calls[0]?.[0].execute()).toMatchObject({ code: null })
  })
  it('recognizes quoted executables and preserves explicit run commands', () => {
    expect(getOpenCodeLaunchExecutable('"/app dir/opencode" run task')).toBe('/app dir/opencode')
    expect(getOpenCodeLaunchExecutable('custom-launcher --standalone', 'opencode')).toBe(
      'custom-launcher'
    )
    expect(getOpenCodeLaunchExecutable('claude')).toBeNull()
  })

  it('uses native resolution with the execution environment and cwd', async () => {
    mocks.resolve.mockResolvedValue('/bin/opencode')
    const env = { PATH: '/bin', OPENCODE_CONFIG_DIR: '/private/config' }
    await probeOpenCodeLaunchCapabilities({
      command: 'opencode run task',
      env,
      cwd: '/repo',
      hostIdentity: 'native-test'
    })
    expect(mocks.resolve).toHaveBeenCalledWith('opencode', { env, cwd: '/repo' })
    expect(mocks.probe).toHaveBeenCalledWith({
      executablePath: '/bin/opencode',
      env,
      cwd: '/repo',
      hostIdentity: 'native-test'
    })
    expect(mocks.wsl).not.toHaveBeenCalled()
  })

  it('uses the relay resolver rather than client PATH resolution', async () => {
    const resolveExecutable = vi.fn().mockResolvedValue('/host/opencode')
    await probeOpenCodeLaunchCapabilities({
      command: 'opencode',
      env: {},
      hostIdentity: 'relay:linux',
      resolveExecutable
    })
    expect(resolveExecutable).toHaveBeenCalledWith('opencode')
    expect(mocks.resolve).not.toHaveBeenCalled()
    expect(mocks.probe).toHaveBeenCalledWith(
      expect.objectContaining({ executablePath: '/host/opencode', hostIdentity: 'relay:linux' })
    )
  })

  it('returns unknown when the host cannot resolve the binary', async () => {
    mocks.resolve.mockResolvedValue(null)
    expect(await probeOpenCodeLaunchCapabilities({ command: 'opencode', env: {} })).toEqual(
      getOpenCodeCliCapabilities(null)
    )
    expect(mocks.probe).not.toHaveBeenCalled()
  })

  it('bounds WSL probes and matches guest cwd plus explicitly imported config roots', async () => {
    const env = {
      HOME: '/native',
      PATH: '/native/bin',
      OPENCODE_CONFIG_DIR: '/guest/config',
      XDG_DATA_HOME: '/guest/data',
      WSLENV: 'OPENCODE_CONFIG_DIR:XDG_DATA_HOME'
    }
    await probeOpenCodeLaunchCapabilities({
      command: 'opencode --standalone',
      env,
      cwd: '\\\\wsl.localhost\\Ubuntu\\home\\user\\repo',
      wsl: { distro: 'Debian' },
      hostIdentity: 'host-a'
    })
    expect(mocks.resolve).not.toHaveBeenCalled()
    const options = mocks.probe.mock.calls[0]?.[0]
    const guestEnv = {
      OPENCODE_CONFIG_DIR: '/guest/config',
      XDG_DATA_HOME: '/guest/data',
      WSLENV: env.WSLENV
    }
    expect(options).toEqual(
      expect.objectContaining({
        executablePath: 'opencode',
        hostIdentity: 'host-a:wsl:Ubuntu',
        cwd: '/home/user/repo',
        env: guestEnv
      })
    )
    await options.execute()
    expect(mocks.wsl).toHaveBeenCalledWith({
      distro: 'Ubuntu',
      loginPath: 'preferred',
      cwd: '/home/user/repo',
      program: 'opencode',
      args: ['--version'],
      env: guestEnv,
      timeoutMs: 5000,
      maxOutputBytes: 4096
    })
  })

  it('does not import native configuration the actual WSL pane would not receive', async () => {
    await probeOpenCodeLaunchCapabilities({
      command: 'opencode',
      env: { OPENCODE_CONFIG_DIR: 'C:\\native' },
      cwd: 'D:\\repo',
      wsl: { distro: 'Ubuntu' }
    })
    expect(mocks.probe).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/mnt/d/repo', env: { WSLENV: '' } })
    )
  })

  it('keeps WSL path translation flags and skips Windows-only values', async () => {
    await probeOpenCodeLaunchCapabilities({
      command: 'opencode',
      env: {
        WSLENV: 'XDG_DATA_HOME/p:WINDOWS_ONLY/w:HOME',
        XDG_DATA_HOME: 'D:\\data',
        WINDOWS_ONLY: 'private',
        HOME: 'C:\\native'
      },
      wsl: {}
    })
    expect(mocks.probe).toHaveBeenCalledWith(
      expect.objectContaining({
        env: { WSLENV: 'XDG_DATA_HOME/p:WINDOWS_ONLY/w:HOME', XDG_DATA_HOME: 'D:\\data' }
      })
    )
  })
})
