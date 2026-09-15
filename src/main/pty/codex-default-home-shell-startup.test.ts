import { describe, expect, it } from 'vitest'
import {
  ORCA_CODEX_DEFAULT_HOME_AFTER_PROFILE_ENV,
  reconcileDaemonCodexDefaultHomeMarker,
  scrubCodexDefaultHomeMarkerForWindowsShell
} from './codex-default-home-shell-startup'

describe('reconcileDaemonCodexDefaultHomeMarker', () => {
  it('keeps a fresh unset request after Orca-owned daemon inheritance is removed', () => {
    const requestedEnv = { [ORCA_CODEX_DEFAULT_HOME_AFTER_PROFILE_ENV]: '1' }
    const env = { ...requestedEnv }

    reconcileDaemonCodexDefaultHomeMarker(env, requestedEnv)

    expect(env[ORCA_CODEX_DEFAULT_HOME_AFTER_PROFILE_ENV]).toBe('1')
  })

  it('applies an unset request over a daemon-only user home', () => {
    const requestedEnv = { [ORCA_CODEX_DEFAULT_HOME_AFTER_PROFILE_ENV]: '1' }
    const env = {
      ...requestedEnv,
      CODEX_HOME: 'C:\\UserCustom\\codex',
      ORCA_CODEX_HOME: 'C:\\Orca\\managed-home'
    }

    reconcileDaemonCodexDefaultHomeMarker(env, requestedEnv)

    expect(env).toEqual({ [ORCA_CODEX_DEFAULT_HOME_AFTER_PROFILE_ENV]: '1' })
  })

  it('applies an explicitly requested default home over daemon inheritance', () => {
    const requestedEnv = {
      CODEX_HOME: 'C:\\Users\\jin\\.codex',
      [ORCA_CODEX_DEFAULT_HOME_AFTER_PROFILE_ENV]: 'C:\\Users\\jin\\.codex'
    }
    const env = {
      ...requestedEnv,
      CODEX_HOME: 'c:/users/jin/.codex/',
      ORCA_CODEX_HOME: 'C:\\UserCustom\\codex'
    }

    reconcileDaemonCodexDefaultHomeMarker(env, requestedEnv)

    expect(env.CODEX_HOME).toBe('C:\\Users\\jin\\.codex')
    expect(env.ORCA_CODEX_HOME).toBeUndefined()
    expect(env[ORCA_CODEX_DEFAULT_HOME_AFTER_PROFILE_ENV]).toBe('C:\\Users\\jin\\.codex')
  })

  it('preserves a daemon-only custom home when main sends no selection', () => {
    const env = { CODEX_HOME: 'C:\\UserCustom\\codex' }

    reconcileDaemonCodexDefaultHomeMarker(env, undefined)

    expect(env).toEqual({ CODEX_HOME: 'C:\\UserCustom\\codex' })
  })

  it('drops a stale marker inherited without an explicit request', () => {
    const env = { [ORCA_CODEX_DEFAULT_HOME_AFTER_PROFILE_ENV]: '1' }

    reconcileDaemonCodexDefaultHomeMarker(env, undefined)

    expect(env[ORCA_CODEX_DEFAULT_HOME_AFTER_PROFILE_ENV]).toBeUndefined()
  })
})

describe('scrubCodexDefaultHomeMarkerForWindowsShell', () => {
  it.each([
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    'C:\\Program Files\\Git\\bin\\bash.exe'
  ])('keeps the one-shot marker for a consuming shell: %s', (shellPath) => {
    const env = { [ORCA_CODEX_DEFAULT_HOME_AFTER_PROFILE_ENV]: '1' }

    scrubCodexDefaultHomeMarkerForWindowsShell(env, shellPath)

    expect(env[ORCA_CODEX_DEFAULT_HOME_AFTER_PROFILE_ENV]).toBe('1')
  })

  it.each(['cmd.exe', 'wsl.exe', 'C:\\msys64\\usr\\bin\\bash.exe'])(
    'removes the marker before an unwrapped shell: %s',
    (shellPath) => {
      const env: Record<string, string> = {
        [ORCA_CODEX_DEFAULT_HOME_AFTER_PROFILE_ENV]: '1'
      }

      scrubCodexDefaultHomeMarkerForWindowsShell(env, shellPath)

      expect(env[ORCA_CODEX_DEFAULT_HOME_AFTER_PROFILE_ENV]).toBeUndefined()
    }
  )
})
