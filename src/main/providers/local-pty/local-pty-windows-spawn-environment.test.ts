import { expect, it } from 'vitest'
import type { LocalPtyLaunchPlan } from './local-pty-launch-plan'
import { finalizeWindowsLocalPtySpawnEnvironment } from './local-pty-windows-spawn-environment'
import type { PtySpawnOptions } from '../pty/provider-contract'

function makePlan(shellPath: string): LocalPtyLaunchPlan {
  return {
    startupAgentRecognition: null,
    defaultCwd: 'C:\\work',
    cwd: 'C:\\work',
    wslInfo: null,
    worktreeWslContext: undefined,
    preferredWslContext: undefined,
    launchWslContext: undefined,
    shellPath,
    shellArgs: [],
    effectiveCwd: 'C:\\work',
    validationCwd: 'C:\\work',
    startupCommandDeliveredInShellArgs: false,
    windowsFallbackAttempts: [],
    shellReadyLaunch: null,
    getFallbackShellReadyConfig: undefined,
    primaryPreLaunchEnv: {},
    isWslShell: false,
    launchWslDistro: null
  }
}

function finalize(shellPath: string, env: Record<string, string>): Record<string, string> {
  const spawn: PtySpawnOptions = { cols: 80, rows: 24, env: {} }
  finalizeWindowsLocalPtySpawnEnvironment({ spawn, plan: makePlan(shellPath), env })
  return env
}

it('exports the pane handle from a Windows shell to child WSL tools (#49580)', () => {
  const env = finalize('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', {
    ORCA_TERMINAL_HANDLE: 'term_a'
  })

  expect(env.WSLENV).toContain('ORCA_TERMINAL_HANDLE/u')
  expect(env.ORCA_TERMINAL_HANDLE).toBe('term_a')
})

it('preserves existing WSLENV entries without duplicating the handle', () => {
  const env = {
    ORCA_TERMINAL_HANDLE: 'term_a',
    WSLENV: 'FOO/u'
  }
  finalize('powershell.exe', env)
  finalize('powershell.exe', env)

  expect(env.WSLENV?.split(':')).toEqual(['FOO/u', 'ORCA_TERMINAL_HANDLE/u'])
})

it('does not create WSLENV when no handle is present', () => {
  const env = finalize('powershell.exe', {})

  expect(env.WSLENV).toBeUndefined()
})

it('keeps the existing wsl.exe passthrough and adds the handle', () => {
  const env = finalize('wsl.exe', {
    ORCA_TERMINAL_HANDLE: 'term_a',
    CODEX_HOME: '/home/user/.codex',
    CLAUDE_CONFIG_DIR: '/home/user/.claude'
  })

  expect(env.WSLENV).toContain('ORCA_TERMINAL_HANDLE/u')
  expect(env.WSLENV).toContain('CODEX_HOME')
  expect(env.WSLENV).toContain('CLAUDE_CONFIG_DIR')
})
