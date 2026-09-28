import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDaemonPtyEnvironment, finalizeDaemonPtyEnvironment } from './spawn-environment'

const owners = {
  ORCA_PI_STATUS_OWNED: '1234',
  ORCA_PRIME_AGENT_STATUS_OWNED: '1234',
  ORCA_PI_TITLE_MARKER_OWNED: '1234'
}
const terminal = {
  ORCA_PANE_KEY: 'new-tab:new-leaf',
  ORCA_AGENT_LAUNCH_TOKEN: 'new-launch',
  ORCA_AGENT_HOOK_TOKEN: 'receiver-token',
  KEEP_ME: 'terminal-value'
}
afterEach(() => vi.unstubAllEnvs())

describe('independent daemon terminal Pi ownership', () => {
  it.each(['host', 'request'] as const)('does not inherit the %s process owner', (source) => {
    if (source === 'host') {
      for (const [key, value] of Object.entries(owners)) {
        vi.stubEnv(key, value)
      }
    }
    const env = createDaemonPtyEnvironment({
      sessionId: 'new-terminal',
      cols: 80,
      rows: 24,
      env: { ...terminal, ...(source === 'request' ? owners : {}) }
    })
    for (const key of Object.keys(owners)) {
      expect(env[key]).toBeUndefined()
    }
    expect(env).toMatchObject(terminal)
  })
  it('scrubs owners reintroduced by shell launch preparation', () => {
    const env: Record<string, string> = { ...terminal, ...owners, APP_ENV: 'kept' }
    finalizeDaemonPtyEnvironment(env, terminal)
    for (const key of Object.keys(owners)) {
      expect(env[key]).toBeUndefined()
    }
    expect(env).toMatchObject({ ...terminal, APP_ENV: 'kept' })
  })
})
