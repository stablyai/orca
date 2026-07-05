import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { existsSyncMock, userInfoMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  userInfoMock: vi.fn()
}))

vi.mock('node:fs', () => ({ existsSync: existsSyncMock }))
vi.mock('node:os', () => ({ userInfo: userInfoMock }))

import { wrapShellSpawnForMacosTccAttribution } from './macos-tcc-login-shell'

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
    userInfoMock.mockReturnValue({ username: 'ada' })
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
    vi.clearAllMocks()
  })

  it('wraps the shell in /usr/bin/login on macOS, preserving the shell args behind it', () => {
    setPlatform('darwin')
    expect(wrapShellSpawnForMacosTccAttribution('/bin/zsh', ['-l'])).toEqual({
      file: '/usr/bin/login',
      args: ['-flpq', 'ada', '/usr/bin/env', 'SHELL=/bin/zsh', '/bin/zsh', '-l']
    })
  })

  it('keeps bash rcfile args intact after the shell path', () => {
    setPlatform('darwin')
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

  it('re-asserts the spawn env SHELL that login(1) would overwrite', () => {
    setPlatform('darwin')
    expect(
      wrapShellSpawnForMacosTccAttribution('/bin/zsh', ['-l'], { SHELL: '/opt/homebrew/bin/fish' })
    ).toEqual({
      file: '/usr/bin/login',
      args: ['-flpq', 'ada', '/usr/bin/env', 'SHELL=/opt/homebrew/bin/fish', '/bin/zsh', '-l']
    })
  })

  it('falls back to the spawned shell for SHELL when the env value is empty', () => {
    setPlatform('darwin')
    expect(wrapShellSpawnForMacosTccAttribution('/bin/zsh', ['-l'], { SHELL: '' })).toEqual({
      file: '/usr/bin/login',
      args: ['-flpq', 'ada', '/usr/bin/env', 'SHELL=/bin/zsh', '/bin/zsh', '-l']
    })
  })

  it('skips the env(1) interposition when the shell path would parse as an assignment', () => {
    setPlatform('darwin')
    expect(wrapShellSpawnForMacosTccAttribution('/odd=dir/zsh', ['-l'])).toEqual({
      file: '/usr/bin/login',
      args: ['-flpq', 'ada', '/odd=dir/zsh', '-l']
    })
  })

  it('still wraps with login when /usr/bin/env is missing, without interposition', () => {
    setPlatform('darwin')
    existsSyncMock.mockImplementation((path: string) => path === '/usr/bin/login')
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
    userInfoMock.mockReturnValue({ username: '' })
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
  })
})
