import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildLocalPtySpawnEnvironment,
  enforceLocalPtySpawnEnvironmentOverrides
} from './local-pty-spawn-environment'
import type { LocalPtyLaunchPlan } from './local-pty-launch-plan'

const ownerEnv = {
  ORCA_PI_STATUS_OWNED: '1234',
  ORCA_PRIME_AGENT_STATUS_OWNED: '1234',
  ORCA_PI_TITLE_MARKER_OWNED: '1234'
}
const terminalEnv = {
  ORCA_PANE_KEY: 'new-tab:new-leaf',
  ORCA_AGENT_LAUNCH_TOKEN: 'new-launch',
  ORCA_AGENT_HOOK_TOKEN: 'receiver-token',
  KEEP_ME: 'terminal-value'
}
const plan: LocalPtyLaunchPlan = {
  startupAgentRecognition: null,
  defaultCwd: '',
  cwd: '',
  wslInfo: null,
  worktreeWslContext: undefined,
  preferredWslContext: undefined,
  launchWslContext: undefined,
  shellPath: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
  shellArgs: [],
  effectiveCwd: '',
  validationCwd: '',
  startupCommandDeliveredInShellArgs: false,
  windowsFallbackAttempts: [],
  shellReadyLaunch: null,
  getFallbackShellReadyConfig: undefined,
  primaryLaunchEnvKeys: [],
  isWslShell: false,
  launchWslDistro: null
}

afterEach(() => vi.unstubAllEnvs())

describe('independent local terminal Pi ownership', () => {
  it.each(['host', 'request'] as const)('does not inherit the %s process owner', async (source) => {
    if (source === 'host') {
      for (const [key, value] of Object.entries(ownerEnv)) {
        vi.stubEnv(key, value)
      }
    }
    const requestedEnv = { ...terminalEnv, ...(source === 'request' ? ownerEnv : {}) }
    const env = await buildLocalPtySpawnEnvironment({
      id: 'new-terminal',
      spawn: { cols: 80, rows: 24, env: requestedEnv },
      getOptions: () => ({}),
      plan
    })
    for (const key of Object.keys(ownerEnv)) {
      expect(env[key]).toBeUndefined()
    }
    expect(env).toMatchObject(terminalEnv)
  })

  it('scrubs owners supplied by a late app-level environment builder', async () => {
    const spawn = { cols: 80, rows: 24, env: terminalEnv }
    const env = await buildLocalPtySpawnEnvironment({
      id: 'new-terminal',
      spawn,
      getOptions: () => ({
        buildSpawnEnv: (_id, baseEnv) => ({ ...baseEnv, ...ownerEnv, APP_ENV: 'kept' })
      }),
      plan
    })
    enforceLocalPtySpawnEnvironmentOverrides(spawn, env)
    for (const key of Object.keys(ownerEnv)) {
      expect(env[key]).toBeUndefined()
    }
    expect(env).toMatchObject({ ...terminalEnv, APP_ENV: 'kept' })
  })
})
