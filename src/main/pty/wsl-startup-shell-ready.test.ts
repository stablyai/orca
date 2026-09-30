import { describe, expect, it } from 'vitest'
import { WSL_UNWRAPPED_SHELL_READY_BLOCK } from '../../shared/wsl-login-shell-command'
import { SHELL_READY_MARKER_ESCAPED } from '../providers/local-pty-shell-ready-marker'
import {
  requestWslShellReadyMarker,
  wslStartupCommandWaitsForShellReady
} from './wsl-startup-shell-ready'

describe('wslStartupCommandWaitsForShellReady', () => {
  const base = {
    shellPath: 'C:\\Windows\\System32\\wsl.exe',
    command: 'claude',
    startupCommandDeliveredInShellArgs: false,
    platform: 'win32' as const
  }

  it('waits for a typed startup command in a WSL pane', () => {
    expect(wslStartupCommandWaitsForShellReady(base)).toBe(true)
    expect(wslStartupCommandWaitsForShellReady({ ...base, shellPath: 'WSL.EXE' })).toBe(true)
  })

  it('does not wait where nothing is typed or the shell is not WSL', () => {
    expect(wslStartupCommandWaitsForShellReady({ ...base, command: undefined })).toBe(false)
    expect(
      wslStartupCommandWaitsForShellReady({ ...base, startupCommandDeliveredInShellArgs: true })
    ).toBe(false)
    expect(wslStartupCommandWaitsForShellReady({ ...base, shellPath: 'powershell.exe' })).toBe(
      false
    )
    expect(wslStartupCommandWaitsForShellReady({ ...base, shellPath: undefined })).toBe(false)
    expect(wslStartupCommandWaitsForShellReady({ ...base, platform: 'linux' })).toBe(false)
  })
})

describe('requestWslShellReadyMarker', () => {
  it('asks for the marker and imports the request into WSL', () => {
    const env: Record<string, string> = { WSLENV: 'ORCA_TERMINAL_HANDLE/u' }
    requestWslShellReadyMarker(env)
    expect(env.ORCA_SHELL_FEATURES).toBe('ready')
    expect(env.WSLENV).toBe('ORCA_TERMINAL_HANDLE/u:ORCA_SHELL_FEATURES')
  })
})

it('the login script emits the same marker the wrappers do', () => {
  expect(WSL_UNWRAPPED_SHELL_READY_BLOCK).toContain(`'${SHELL_READY_MARKER_ESCAPED}'`)
})
