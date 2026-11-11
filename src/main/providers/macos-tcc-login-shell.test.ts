import { spawnSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as LoginSessionPtyProbe from './macos-login-session-pty-probe'

const { existsSyncMock, userInfoMock, runProcessMock, ptyProbeMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  userInfoMock: vi.fn(),
  runProcessMock: vi.fn(),
  ptyProbeMock: vi.fn()
}))

vi.mock('node:fs', () => ({ existsSync: existsSyncMock }))
vi.mock('node:os', () => ({ userInfo: userInfoMock }))
// Process-host owns encoding/signals/caps; this suite checks PAM argv and verdicts.
vi.mock('@orca/process-host', () => ({
  runProcess: (...args: unknown[]) => Promise.resolve(runProcessMock(...args))
}))
vi.mock('./macos-login-session-pty-probe', async (importOriginal) => ({
  ...(await importOriginal<typeof LoginSessionPtyProbe>()),
  runMacosLoginSessionPtyProbe: ptyProbeMock
}))

import {
  MACOS_TCC_SHELL_TRAMPOLINE,
  prepareMacosTccLoginShell,
  probeMacosLoginSessionAlive,
  resetMacosLoginShellPreflightForTests,
  wrapShellSpawnForMacosTccAttribution
} from './macos-tcc-login-shell'

const itOnPosixHost = process.platform === 'win32' ? it.skip : it

const ACCEPTED_RESULT = {
  code: 0,
  signal: null,
  stdout: 'ORCA_LOGIN_PREFLIGHT_OK',
  stderr: '',
  timedOut: false
}
const REJECTED_RESULT = { code: 1, signal: null, stdout: '', stderr: '', timedOut: false }
const ACCEPTED_OUTCOME = { ok: true, conclusive: true, reason: 'accepted' } as const
const REJECTED_OUTCOME = { ok: false, conclusive: true, reason: 'rejected' } as const
void (process.platform === 'win32' ? it.skip : it)

describe('probeMacosLoginSessionAlive', () => {
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
    runProcessMock.mockResolvedValue({
      code: 0,
      signal: null,
      stdout: 'ORCA_LOGIN_PREFLIGHT_OK',
      stderr: '',
      timedOut: false
    })
    ptyProbeMock.mockResolvedValue({ ok: true, conclusive: true, reason: 'accepted' })
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

  it('does not let a spawn-path probe overwrite a newer death verdict', async () => {
    setPlatform('darwin')
    ptyProbeMock.mockResolvedValue(REJECTED_OUTCOME)
    const finishers: ((result: typeof ACCEPTED_RESULT) => void)[] = []
    runProcessMock.mockImplementation(() => new Promise((resolve) => finishers.push(resolve)))

    const freshProbe = probeMacosLoginSessionAlive()
    const spawnProbe = prepareMacosTccLoginShell()
    expect(runProcessMock).toHaveBeenCalledTimes(2)

    finishers[0](REJECTED_RESULT)
    await expect(freshProbe).resolves.toEqual(REJECTED_OUTCOME)
    finishers[1](ACCEPTED_RESULT)
    await expect(spawnProbe).resolves.toEqual(ACCEPTED_OUTCOME)

    expect(wrapShellSpawnForMacosTccAttribution('/bin/zsh', ['-l']).file).toBe('/bin/zsh')
  })

  it('wraps a prepared login shell with the pane-exit trampoline', async () => {
    setPlatform('darwin')
    await prepareMacosTccLoginShell()
    const wrapped = wrapShellSpawnForMacosTccAttribution('/bin/zsh', ['-l'])
    expect(wrapped.args).toContain(MACOS_TCC_SHELL_TRAMPOLINE)
  })

  itOnPosixHost('reports a non-zero inner command status through the pane-exit OSC', () => {
    const result = spawnSync(
      '/bin/bash',
      [
        '--noprofile',
        '--norc',
        '-p',
        '-c',
        MACOS_TCC_SHELL_TRAMPOLINE,
        'orca-tcc-login',
        '/bin/sh',
        '/bin/sh',
        '-c',
        'exit 42'
      ],
      { encoding: 'utf8' }
    )

    expect(result.status).toBe(42)
    expect(result.stdout).toContain('\x1b]777;orca-pane-exit:42\x07')
  })
})
