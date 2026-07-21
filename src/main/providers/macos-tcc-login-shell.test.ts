import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { existsSyncMock, userInfoMock, execFileMock, stdinEndMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  userInfoMock: vi.fn(),
  execFileMock: vi.fn(),
  stdinEndMock: vi.fn()
}))

vi.mock('node:fs', () => ({ existsSync: existsSyncMock }))
vi.mock('node:os', () => ({ userInfo: userInfoMock }))
vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import {
  prepareMacosTccLoginShell,
  resetMacosLoginShellPreflightForTests,
  wrapShellSpawnForMacosTccAttribution
} from './macos-tcc-login-shell'

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void

describe('wrapShellSpawnForMacosTccAttribution', () => {
  let origPlatform: PropertyDescriptor | undefined
  let origDisable: string | undefined

  function setPlatform(value: string): void {
    Object.defineProperty(process, 'platform', { configurable: true, value })
  }

  beforeEach(() => {
    origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    origDisable = process.env.ORCA_DISABLE_MACOS_LOGIN_SHELL
    delete process.env.ORCA_DISABLE_MACOS_LOGIN_SHELL
    existsSyncMock.mockReturnValue(true)
    userInfoMock.mockReturnValue({ username: 'ada', homedir: '/Users/ada' })
    execFileMock.mockImplementation(
      (_file: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
        callback(null, 'ORCA_LOGIN_PREFLIGHT_OK', '')
        return { stdin: { end: stdinEndMock } }
      }
    )
    resetMacosLoginShellPreflightForTests()
  })

  afterEach(() => {
    if (origPlatform) {
      Object.defineProperty(process, 'platform', origPlatform)
    }
    if (origDisable === undefined) {
      delete process.env.ORCA_DISABLE_MACOS_LOGIN_SHELL
    } else {
      process.env.ORCA_DISABLE_MACOS_LOGIN_SHELL = origDisable
    }
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('wraps the shell in /usr/bin/login on macOS, preserving the shell args behind it', async () => {
    setPlatform('darwin')
    await prepareMacosTccLoginShell()
    expect(wrapShellSpawnForMacosTccAttribution('/bin/zsh', ['-l'])).toEqual({
      file: '/usr/bin/login',
      args: ['-flpq', 'ada', '/usr/bin/env', 'SHELL=/bin/zsh', '/bin/zsh', '-l']
    })
    expect(execFileMock).toHaveBeenCalledWith(
      '/usr/bin/login',
      ['-flpq', 'ada', '/usr/bin/printf', 'ORCA_LOGIN_PREFLIGHT_OK'],
      {
        cwd: '/Users/ada',
        encoding: 'utf8',
        killSignal: 'SIGKILL',
        maxBuffer: 1024,
        timeout: 500
      },
      expect.any(Function)
    )
    expect(stdinEndMock).toHaveBeenCalledOnce()
  })

  it('spawns the shell directly when login PAM policy rejects the current user', async () => {
    setPlatform('darwin')
    execFileMock.mockImplementation(
      (_file: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
        callback(null, 'Login incorrect\nlogin: ', '')
        return { stdin: { end: stdinEndMock } }
      }
    )
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await prepareMacosTccLoginShell()
    expect(wrapShellSpawnForMacosTccAttribution('/bin/zsh', ['-l'])).toEqual({
      file: '/bin/zsh',
      args: ['-l']
    })
    expect(console.warn).toHaveBeenCalledWith(
      '[pty] macOS login(1) preflight failed; spawning shells directly'
    )
  })

  it('caches a conclusive PAM rejection for later terminal spawns', async () => {
    setPlatform('darwin')
    execFileMock.mockImplementation(
      (_file: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
        // login(1) exiting non-zero on its own is a deterministic PAM verdict.
        callback(Object.assign(new Error('login incorrect'), { code: 1 }), '', '')
        return { stdin: { end: stdinEndMock } }
      }
    )
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await prepareMacosTccLoginShell()
    await prepareMacosTccLoginShell()
    expect(wrapShellSpawnForMacosTccAttribution('/bin/zsh', ['-l']).file).toBe('/bin/zsh')
    expect(wrapShellSpawnForMacosTccAttribution('/bin/bash', ['-l']).file).toBe('/bin/bash')
    expect(execFileMock).toHaveBeenCalledTimes(1)
    expect(console.warn).toHaveBeenCalledTimes(1)
  })

  it('backs off repeated transient timeouts instead of delaying every terminal spawn (F1)', async () => {
    setPlatform('darwin')
    let now = 1_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    // A probe our own SIGKILL cap killed proves nothing about PAM; it must retry.
    execFileMock.mockImplementation(
      (_file: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
        callback(Object.assign(new Error('timed out'), { killed: true }), '', '')
        return { stdin: { end: stdinEndMock } }
      }
    )
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const first = await prepareMacosTccLoginShell()
    expect(first).toEqual({ ok: false, conclusive: false, reason: 'timeout' })
    // Degraded probe fails open to a direct shell for this spawn...
    expect(wrapShellSpawnForMacosTccAttribution('/bin/zsh', ['-l']).file).toBe('/bin/zsh')

    // ...without making every subsequent terminal pay the same 500 ms timeout.
    await prepareMacosTccLoginShell()
    expect(execFileMock).toHaveBeenCalledOnce()

    now += 5_000
    await prepareMacosTccLoginShell()
    expect(execFileMock).toHaveBeenCalledTimes(2)

    // Repeated failures back off further rather than spawning login(1) every 5 seconds.
    now += 5_000
    await prepareMacosTccLoginShell()
    expect(execFileMock).toHaveBeenCalledTimes(2)
    now += 5_000
    await prepareMacosTccLoginShell()
    expect(execFileMock).toHaveBeenCalledTimes(3)
  })

  it('self-heals to the login wrapper once a re-probe succeeds (F1)', async () => {
    setPlatform('darwin')
    let now = 1_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    let attempt = 0
    execFileMock.mockImplementation(
      (_file: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
        attempt += 1
        if (attempt === 1) {
          callback(Object.assign(new Error('timed out'), { killed: true }), '', '')
        } else {
          callback(null, 'ORCA_LOGIN_PREFLIGHT_OK', '')
        }
        return { stdin: { end: stdinEndMock } }
      }
    )
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await prepareMacosTccLoginShell()
    await prepareMacosTccLoginShell()
    expect(execFileMock).toHaveBeenCalledOnce()
    now += 5_000
    await prepareMacosTccLoginShell()
    expect(execFileMock).toHaveBeenCalledTimes(2)
    expect(wrapShellSpawnForMacosTccAttribution('/bin/zsh', ['-l']).file).toBe('/usr/bin/login')
  })

  it('returns a conclusive outcome the daemon can log structurally (F2)', async () => {
    setPlatform('darwin')
    execFileMock.mockImplementation(
      (_file: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
        callback(null, 'Login incorrect\nlogin: ', '')
        return { stdin: { end: stdinEndMock } }
      }
    )
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const outcome = await prepareMacosTccLoginShell()
    expect(outcome).toEqual({ ok: false, conclusive: true, reason: 'rejected' })
    // A second call is short-circuited by the cache, so nothing new to log.
    expect(await prepareMacosTccLoginShell()).toBeNull()
  })

  it('rejects a marker emitted by a preflight that does not exit cleanly', async () => {
    setPlatform('darwin')
    execFileMock.mockImplementation(
      (_file: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
        callback(
          Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }),
          'ORCA_LOGIN_PREFLIGHT_OK',
          ''
        )
        return { stdin: { end: stdinEndMock } }
      }
    )
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await prepareMacosTccLoginShell()
    expect(wrapShellSpawnForMacosTccAttribution('/bin/zsh', ['-l'])).toEqual({
      file: '/bin/zsh',
      args: ['-l']
    })
  })

  it('dedupes concurrent successful preflights and caches later terminal spawns', async () => {
    setPlatform('darwin')

    await Promise.all([prepareMacosTccLoginShell(), prepareMacosTccLoginShell()])
    expect(wrapShellSpawnForMacosTccAttribution('/bin/zsh', ['-l']).file).toBe('/usr/bin/login')
    expect(wrapShellSpawnForMacosTccAttribution('/bin/bash', ['-l']).file).toBe('/usr/bin/login')
    expect(execFileMock).toHaveBeenCalledTimes(1)
  })

  it('keeps bash rcfile args intact after the shell path', async () => {
    setPlatform('darwin')
    await prepareMacosTccLoginShell()
    expect(
      wrapShellSpawnForMacosTccAttribution('/bin/bash', ['--rcfile', '/orca/bash/rcfile'])
    ).toEqual({
      file: '/usr/bin/login',
      args: [
        '-flpq',
        'ada',
        '/usr/bin/env',
        'SHELL=/bin/bash',
        '/bin/bash',
        '--rcfile',
        '/orca/bash/rcfile'
      ]
    })
  })

  it('re-asserts the spawn env SHELL that login(1) would overwrite', async () => {
    setPlatform('darwin')
    await prepareMacosTccLoginShell()
    expect(
      wrapShellSpawnForMacosTccAttribution('/bin/zsh', ['-l'], { SHELL: '/opt/homebrew/bin/fish' })
    ).toEqual({
      file: '/usr/bin/login',
      args: ['-flpq', 'ada', '/usr/bin/env', 'SHELL=/opt/homebrew/bin/fish', '/bin/zsh', '-l']
    })
  })

  it('falls back to the spawned shell for SHELL when the env value is empty', async () => {
    setPlatform('darwin')
    await prepareMacosTccLoginShell()
    expect(wrapShellSpawnForMacosTccAttribution('/bin/zsh', ['-l'], { SHELL: '' })).toEqual({
      file: '/usr/bin/login',
      args: ['-flpq', 'ada', '/usr/bin/env', 'SHELL=/bin/zsh', '/bin/zsh', '-l']
    })
  })

  it('skips the env(1) interposition when the shell path would parse as an assignment', async () => {
    setPlatform('darwin')
    await prepareMacosTccLoginShell()
    expect(wrapShellSpawnForMacosTccAttribution('/odd=dir/zsh', ['-l'])).toEqual({
      file: '/usr/bin/login',
      args: ['-flpq', 'ada', '/odd=dir/zsh', '-l']
    })
  })

  it('still wraps with login when /usr/bin/env is missing, without interposition', async () => {
    setPlatform('darwin')
    existsSyncMock.mockImplementation(
      (path: string) => path === '/usr/bin/login' || path === '/usr/bin/printf'
    )
    await prepareMacosTccLoginShell()
    expect(wrapShellSpawnForMacosTccAttribution('/bin/zsh', ['-l'])).toEqual({
      file: '/usr/bin/login',
      args: ['-flpq', 'ada', '/bin/zsh', '-l']
    })
  })

  it('is a no-op on non-macOS platforms', () => {
    setPlatform('linux')
    expect(wrapShellSpawnForMacosTccAttribution('/bin/zsh', ['-l'])).toEqual({
      file: '/bin/zsh',
      args: ['-l']
    })
  })

  it('is idempotent when the file is already /usr/bin/login', () => {
    setPlatform('darwin')
    const args = ['-flpq', 'ada', '/bin/zsh', '-l']
    expect(wrapShellSpawnForMacosTccAttribution('/usr/bin/login', args)).toEqual({
      file: '/usr/bin/login',
      args
    })
  })

  it('falls back to the plain spawn when the login binary is missing', () => {
    setPlatform('darwin')
    existsSyncMock.mockReturnValue(false)
    expect(wrapShellSpawnForMacosTccAttribution('/bin/zsh', ['-l'])).toEqual({
      file: '/bin/zsh',
      args: ['-l']
    })
  })

  it('falls back to the plain spawn when the username cannot be resolved', () => {
    setPlatform('darwin')
    userInfoMock.mockImplementation(() => {
      throw new Error('no user')
    })
    expect(wrapShellSpawnForMacosTccAttribution('/bin/zsh', ['-l'])).toEqual({
      file: '/bin/zsh',
      args: ['-l']
    })
  })

  it('falls back to the plain spawn when the username is empty', () => {
    setPlatform('darwin')
    userInfoMock.mockReturnValue({ username: '', homedir: '/Users/ada' })
    expect(wrapShellSpawnForMacosTccAttribution('/bin/zsh', ['-l'])).toEqual({
      file: '/bin/zsh',
      args: ['-l']
    })
  })

  it('falls back to the plain spawn when disabled via env', () => {
    setPlatform('darwin')
    process.env.ORCA_DISABLE_MACOS_LOGIN_SHELL = '1'
    expect(wrapShellSpawnForMacosTccAttribution('/bin/zsh', ['-l'])).toEqual({
      file: '/bin/zsh',
      args: ['-l']
    })
    expect(execFileMock).not.toHaveBeenCalled()
  })
})
