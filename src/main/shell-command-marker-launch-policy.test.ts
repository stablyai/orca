import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getShellLaunchConfig as getDaemonShellLaunchConfig } from './daemon/shell-ready'
import { getShellLaunchConfig as getLocalShellLaunchConfig } from './providers/local-pty-shell-ready'
import type { ShellStartupFeature } from './shell-startup-features'

const TEST_NONCE = 'test-nonce'
const launchers = [
  {
    name: 'local',
    disableEnv: 'ORCA_DISABLE_SHELL_COMMAND_MARKERS_LOCAL_NATIVE',
    launch: (shell: string, features: readonly ShellStartupFeature[], nonce?: string) =>
      getLocalShellLaunchConfig(shell, features, {
        ...(nonce ? { commandNonce: nonce } : {}),
        hostClass: 'local-native'
      })
  },
  {
    name: 'daemon',
    disableEnv: 'ORCA_DISABLE_SHELL_COMMAND_MARKERS_DAEMON_NATIVE',
    launch: (shell: string, features: readonly ShellStartupFeature[], nonce?: string) =>
      getDaemonShellLaunchConfig(shell, features, nonce ? { commandNonce: nonce } : {})
  }
] as const

describe('shell command marker launch policy', () => {
  let userDataPath = ''
  const previousPolicyEnv = new Map<string, string | undefined>()
  let previousUserDataPath: string | undefined

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-marker-launch-policy-'))
    previousUserDataPath = process.env.ORCA_USER_DATA_PATH
    process.env.ORCA_USER_DATA_PATH = userDataPath
    for (const { disableEnv } of launchers) {
      previousPolicyEnv.set(disableEnv, process.env[disableEnv])
      delete process.env[disableEnv]
    }
  })

  afterEach(() => {
    if (previousUserDataPath === undefined) {
      delete process.env.ORCA_USER_DATA_PATH
    } else {
      process.env.ORCA_USER_DATA_PATH = previousUserDataPath
    }
    for (const { disableEnv } of launchers) {
      const previous = previousPolicyEnv.get(disableEnv)
      if (previous === undefined) {
        delete process.env[disableEnv]
      } else {
        process.env[disableEnv] = previous
      }
    }
    previousPolicyEnv.clear()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it.each(launchers)('keeps a $name pane with no features unwrapped', ({ launch }) => {
    expect(launch('/bin/fish', [])).toMatchObject({
      mode: 'unwrapped',
      supportsCommandMarkers: false
    })
  })

  it.each(launchers)(
    'keeps a $name markers-only pane unwrapped when nonce injection fails',
    ({ launch }) => {
      expect(launch('/bin/fish', ['markers'])).toMatchObject({
        mode: 'unwrapped',
        supportsCommandMarkers: false,
        failureReason: 'marker-injection-unavailable'
      })
    }
  )

  it.each(launchers)('wraps a $name markers-only pane after nonce injection', ({ launch }) => {
    expect(launch('/bin/fish', ['markers'], TEST_NONCE)).toMatchObject({
      mode: 'wrapped',
      env: { ORCA_SHELL_COMMAND_NONCE: TEST_NONCE },
      supportsCommandMarkers: true
    })
  })

  it.each(launchers)(
    'keeps a $name markers-only pane unwrapped behind its host kill switch',
    ({ disableEnv, launch }) => {
      process.env[disableEnv] = '1'
      expect(launch('/bin/fish', ['markers'], TEST_NONCE)).toMatchObject({
        mode: 'unwrapped',
        supportsCommandMarkers: false,
        failureReason: 'host-class-disabled'
      })
    }
  )

  it.each(launchers)(
    'preserves a $name history wrapper while its marker kill switch is active',
    ({ disableEnv, launch }) => {
      process.env[disableEnv] = '1'
      expect(launch('/bin/zsh', ['history', 'markers'], TEST_NONCE)).toMatchObject({
        mode: 'wrapped',
        env: { ORCA_SHELL_FEATURES: 'history' },
        supportsCommandMarkers: false
      })
    }
  )
})
