import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDaemonPtyEnvironment } from '../daemon/pty-subprocess/spawn-environment'
import { buildLocalPtySpawnEnvironment } from '../providers/local-pty-spawn-environment'
import type { LocalPtyLaunchPlan } from '../providers/local-pty-launch-plan'
import { removeInheritedFigtermSessionEnv } from './figterm-session-env'

// Values figterm exports inside its PTY (Q_TERM carries the Kiro CLI version).
const figtermEnv = {
  Q_TERM: '2.27.1',
  Q_TERM_TMUX: '2.27.1',
  QTERM_SESSION_ID: 'c0ffee'
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
  primaryPreLaunchEnv: {},
  isWslShell: false,
  launchWslDistro: null
}

function stubFigtermHost(): void {
  for (const [key, value] of Object.entries(figtermEnv)) {
    vi.stubEnv(key, value)
  }
}

afterEach(() => vi.unstubAllEnvs())

describe('inherited figterm session env', () => {
  it('removes the figterm markers and keeps other variables', () => {
    const env = { ...figtermEnv, Q_SET_PARENT_CHECK: '1', TERM: 'xterm-256color' }

    removeInheritedFigtermSessionEnv(env)

    expect(env).toEqual({ Q_SET_PARENT_CHECK: '1', TERM: 'xterm-256color' })
  })

  it('does not reach a local terminal when Orca was started inside figterm', async () => {
    stubFigtermHost()
    const env = await buildLocalPtySpawnEnvironment({
      id: 'new-terminal',
      spawn: { cols: 80, rows: 24, env: { KEEP_ME: 'terminal-value' } },
      getOptions: () => ({}),
      plan
    })

    for (const key of Object.keys(figtermEnv)) {
      expect(env[key]).toBeUndefined()
    }
    expect(env.KEEP_ME).toBe('terminal-value')
  })

  it('does not reach a daemon terminal when the daemon was started inside figterm', () => {
    stubFigtermHost()
    const env = createDaemonPtyEnvironment({
      sessionId: 'new-terminal',
      cols: 80,
      rows: 24,
      env: { KEEP_ME: 'terminal-value' }
    })

    for (const key of Object.keys(figtermEnv)) {
      expect(env[key]).toBeUndefined()
    }
    expect(env.KEEP_ME).toBe('terminal-value')
  })
})
