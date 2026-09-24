import { afterEach, describe, expect, it, vi } from 'vitest'
import * as pty from 'node-pty'
import { spawnShellWithFallback } from '../providers/local-pty-utils'
import { spawnNativeDaemonPty } from '../daemon/pty-subprocess/native-pty-spawn'
import { normalizeWindowsNativeShellEnvironment } from './windows-native-shell-environment'

vi.mock('node-pty', () => ({ spawn: vi.fn() }))
vi.mock('../windows/windows-pty-job', () => ({ assignHostProcessToKillOnCloseJob: vi.fn() }))

const originalPlatform = process.platform
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform })
  vi.restoreAllMocks()
})

const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const CMD = 'C:\\Windows\\System32\\cmd.exe'
const TEMP = 'C:\\Users\\Alice Smith\\AppData\\Local\\Temp'
const inheritedEnvironment = (): Record<string, string> => ({
  SHELL: '/usr/bin/bash',
  MSYSTEM: 'MINGW64',
  EXEPATH: 'C:\\Program Files\\Git\\bin',
  TEMP: '/tmp',
  TMP: '/tmp',
  LOCALAPPDATA: 'C:\\Users\\Alice Smith\\AppData\\Local',
  ORCA_PANE_KEY: 'test-pane',
  ORCA_AGENT_HOOK_ENDPOINT: 'C:\\hooks\\endpoint.cmd'
})

describe('native temporary directory normalization', () => {
  it('preserves custom drive and UNC directories', () => {
    const env = { TEMP: 'D:\\custom temp', TMP: '\\\\server\\share\\temp' }
    normalizeWindowsNativeShellEnvironment(env, POWERSHELL, 'win32')
    expect(env).toMatchObject({ TEMP: 'D:\\custom temp', TMP: '\\\\server\\share\\temp' })
  })

  it('reuses a valid native override to repair only the invalid variable', () => {
    const env = { TEMP: 'D:/custom temp', TMP: '/tmp' }
    normalizeWindowsNativeShellEnvironment(env, POWERSHELL, 'win32')
    expect(env).toMatchObject({ TEMP: 'D:/custom temp', TMP: 'D:/custom temp' })
  })

  it('handles mixed-case Windows environment names and stale aliases', () => {
    const env: Record<string, string> = {
      Shell: '/bin/bash',
      SHELL: '/usr/bin/bash',
      Msystem: 'MINGW64',
      ExePath: 'C:\\Git',
      Temp: '/tmp',
      Tmp: '/tmp',
      LocalAppData: 'C:\\Users\\Alice Smith\\AppData\\Local'
    }
    normalizeWindowsNativeShellEnvironment(env, POWERSHELL, 'win32')
    expect(env).toEqual({
      SHELL: POWERSHELL,
      Temp: TEMP,
      Tmp: TEMP,
      LocalAppData: 'C:\\Users\\Alice Smith\\AppData\\Local'
    })
  })

  it('does not introduce temp overrides into an environment without them', () => {
    const env = { LOCALAPPDATA: 'C:\\Users\\Alice\\AppData\\Local' }
    normalizeWindowsNativeShellEnvironment(env, POWERSHELL, 'win32')
    expect(env).not.toHaveProperty('TEMP')
    expect(env).not.toHaveProperty('TMP')
  })

  it('drops invalid overrides when there is no native fallback', () => {
    const env: Record<string, string> = { TEMP: '/tmp', TMP: '\\tmp' }
    normalizeWindowsNativeShellEnvironment(env, POWERSHELL, 'win32')
    expect(env).toEqual({ SHELL: POWERSHELL })
  })
})

describe.each(['local', 'daemon'] as const)('%s native shell environment', (route) => {
  function spawn(shellPath: string, env: Record<string, string>, fallback = false): void {
    const attempts = [shellPath, CMD].map((path) => ({
      shellPath: path,
      shellArgs: [],
      effectiveCwd: 'C:\\repo',
      validationCwd: 'C:\\repo',
      startupCommandDeliveredInShellArgs: false
    }))
    const args = {
      shellPath,
      shellArgs: [],
      env,
      cols: 80,
      rows: 24,
      windowsFallbackAttempts: fallback ? attempts : []
    }
    if (route === 'local') {
      spawnShellWithFallback({ ...args, cwd: 'C:\\repo', ptySpawn: pty.spawn })
    } else {
      spawnNativeDaemonPty({ ...args, spawnCwd: 'C:\\repo' })
    }
  }

  it.each([POWERSHELL, CMD])(
    'does not advertise the parent Git Bash to children of %s',
    (shell) => {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      const env = inheritedEnvironment()
      spawn(shell, env)
      expect(pty.spawn).toHaveBeenLastCalledWith(
        shell,
        [],
        expect.objectContaining({
          env: expect.objectContaining({
            SHELL: shell,
            TEMP,
            TMP: TEMP,
            ORCA_PANE_KEY: 'test-pane',
            ORCA_AGENT_HOOK_ENDPOINT: 'C:\\hooks\\endpoint.cmd'
          })
        })
      )
      expect(env).not.toHaveProperty('MSYSTEM')
      expect(env).not.toHaveProperty('EXEPATH')
    }
  )

  it('normalizes each fallback using the shell that actually starts', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(pty.spawn).mockImplementationOnce(() => {
      throw new Error('spawn failed')
    })
    const env = inheritedEnvironment()
    spawn(POWERSHELL, env, true)
    expect(env.SHELL).toBe(CMD)
    expect(env.TEMP).toBe(TEMP)
  })

  it.each(['C:\\Program Files\\Git\\bin\\bash.exe', 'wsl.exe'])(
    'preserves intentional %s environments',
    (shell) => {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      const env = inheritedEnvironment()
      spawn(shell, env)
      expect(env).toEqual(inheritedEnvironment())
    }
  )

  it('leaves a POSIX execution host untouched', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    const env = inheritedEnvironment()
    spawn(process.execPath, env)
    expect(env).toEqual(inheritedEnvironment())
  })
})
