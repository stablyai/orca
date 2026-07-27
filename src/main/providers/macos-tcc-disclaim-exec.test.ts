import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as LoginSessionPtyProbe from './macos-login-session-pty-probe'

const { existsSyncMock, userInfoMock, execFileMock, stdinEndMock, ptyProbeMock } = vi.hoisted(
  () => ({
    existsSyncMock: vi.fn(),
    userInfoMock: vi.fn(),
    execFileMock: vi.fn(),
    stdinEndMock: vi.fn(),
    ptyProbeMock: vi.fn()
  })
)

vi.mock('node:fs', () => ({ existsSync: existsSyncMock }))
vi.mock('node:os', () => ({ userInfo: userInfoMock }))
vi.mock('node:child_process', () => ({ execFile: execFileMock }))
vi.mock('./macos-login-session-pty-probe', async (importOriginal) => ({
  ...(await importOriginal<typeof LoginSessionPtyProbe>()),
  runMacosLoginSessionPtyProbe: ptyProbeMock
}))

import {
  resetMacosTccDisclaimShimForTests,
  resolveMacosTccDisclaimShimPath
} from './macos-tcc-disclaim-exec'
import {
  prepareMacosTccLoginShell,
  resetMacosLoginShellPreflightForTests,
  wrapShellSpawnForMacosTccAttribution
} from './macos-tcc-login-shell'

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void

// The shim resolves beside the running executable, mirroring the packaged and
// dev bundle layout (Contents/MacOS).
const SHIM_PATH = join(dirname(process.execPath), 'orca-tcc-disclaim-exec')

describe('wrapShellSpawnForMacosTccAttribution with ORCA_MACOS_TCC_DISCLAIM', () => {
  let origPlatform: PropertyDescriptor | undefined
  let origDisable: string | undefined
  let origDisclaim: string | undefined

  function setPlatform(value: string): void {
    Object.defineProperty(process, 'platform', { configurable: true, value })
  }

  beforeEach(() => {
    origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    origDisable = process.env.ORCA_DISABLE_MACOS_LOGIN_SHELL
    origDisclaim = process.env.ORCA_MACOS_TCC_DISCLAIM
    delete process.env.ORCA_DISABLE_MACOS_LOGIN_SHELL
    delete process.env.ORCA_MACOS_TCC_DISCLAIM
    existsSyncMock.mockReturnValue(true)
    userInfoMock.mockReturnValue({ username: 'ada', homedir: '/Users/ada' })
    execFileMock.mockImplementation(
      (_file: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
        callback(null, 'ORCA_LOGIN_PREFLIGHT_OK', '')
        return { stdin: { end: stdinEndMock } }
      }
    )
    ptyProbeMock.mockResolvedValue({ ok: false, conclusive: true, reason: 'rejected' })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    resetMacosLoginShellPreflightForTests()
    resetMacosTccDisclaimShimForTests()
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
    if (origDisclaim === undefined) {
      delete process.env.ORCA_MACOS_TCC_DISCLAIM
    } else {
      process.env.ORCA_MACOS_TCC_DISCLAIM = origDisclaim
    }
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('keeps the login(1) wrap byte-identical when the flag is unset (the default)', async () => {
    setPlatform('darwin')
    await prepareMacosTccLoginShell()
    expect(wrapShellSpawnForMacosTccAttribution('/bin/zsh', ['-l'])).toEqual({
      file: '/usr/bin/login',
      args: ['-flpq', 'ada', '/usr/bin/env', 'SHELL=/bin/zsh', '/bin/zsh', '-l']
    })
    // The default path never stats the shim binary and never logs about it.
    expect(existsSyncMock).not.toHaveBeenCalledWith(SHIM_PATH)
    expect(console.log).not.toHaveBeenCalled()
  })

  it('swaps the login(1) wrap for the shim drop-in when the flag is on and the shim exists', async () => {
    setPlatform('darwin')
    process.env.ORCA_MACOS_TCC_DISCLAIM = '1'
    expect(wrapShellSpawnForMacosTccAttribution('/bin/zsh', ['-l'])).toEqual({
      file: SHIM_PATH,
      args: ['/bin/zsh', '-l']
    })
    // No PAM preflight, subprocess, or env(1) interposition on the shim path.
    expect(execFileMock).not.toHaveBeenCalled()
    // The rootless live signal that the disclaim path fired (SETEXEC leaves no
    // process-tree trace to observe otherwise).
    expect(console.log).toHaveBeenCalledWith(
      `[pty] macOS TCC disclaim shim wrap engaged: ${SHIM_PATH}`
    )
  })

  it('preserves trailing shell args behind the original file argument', async () => {
    setPlatform('darwin')
    process.env.ORCA_MACOS_TCC_DISCLAIM = 'true'
    expect(
      wrapShellSpawnForMacosTccAttribution('/bin/bash', ['--rcfile', '/orca/bash/rcfile'])
    ).toEqual({
      file: SHIM_PATH,
      args: ['/bin/bash', '--rcfile', '/orca/bash/rcfile']
    })
  })

  it('memoizes the shim resolution so spawns do not re-stat it', () => {
    setPlatform('darwin')
    process.env.ORCA_MACOS_TCC_DISCLAIM = '1'
    wrapShellSpawnForMacosTccAttribution('/bin/zsh', ['-l'])
    wrapShellSpawnForMacosTccAttribution('/bin/bash', ['-l'])
    expect(existsSyncMock).toHaveBeenCalledTimes(1)
    expect(existsSyncMock).toHaveBeenCalledWith(SHIM_PATH)
  })

  it('is idempotent when the file is already the shim', () => {
    setPlatform('darwin')
    process.env.ORCA_MACOS_TCC_DISCLAIM = '1'
    const args = ['/bin/zsh', '-l']
    expect(wrapShellSpawnForMacosTccAttribution(SHIM_PATH, args)).toEqual({
      file: SHIM_PATH,
      args
    })
  })

  it('falls back to the login(1) wrap when the flag is on but the shim is absent', async () => {
    setPlatform('darwin')
    process.env.ORCA_MACOS_TCC_DISCLAIM = '1'
    existsSyncMock.mockImplementation((path: string) => !path.endsWith('orca-tcc-disclaim-exec'))
    await prepareMacosTccLoginShell()
    expect(wrapShellSpawnForMacosTccAttribution('/bin/zsh', ['-l'])).toEqual({
      file: '/usr/bin/login',
      args: ['-flpq', 'ada', '/usr/bin/env', 'SHELL=/bin/zsh', '/bin/zsh', '-l']
    })
  })

  it('keeps the plain-spawn escape hatch authoritative over the flag', () => {
    setPlatform('darwin')
    process.env.ORCA_MACOS_TCC_DISCLAIM = '1'
    process.env.ORCA_DISABLE_MACOS_LOGIN_SHELL = '1'
    expect(wrapShellSpawnForMacosTccAttribution('/bin/zsh', ['-l'])).toEqual({
      file: '/bin/zsh',
      args: ['-l']
    })
    expect(existsSyncMock).not.toHaveBeenCalled()
  })

  it('is a no-op on non-macOS platforms even with the flag on', () => {
    setPlatform('linux')
    process.env.ORCA_MACOS_TCC_DISCLAIM = '1'
    expect(wrapShellSpawnForMacosTccAttribution('/bin/zsh', ['-l'])).toEqual({
      file: '/bin/zsh',
      args: ['-l']
    })
    expect(resolveMacosTccDisclaimShimPath()).toBeNull()
    expect(existsSyncMock).not.toHaveBeenCalled()
  })
})
