import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDaemonPtyEnvironment } from './spawn-environment'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('daemon PTY env and the host launcher port block', () => {
  it("keeps the pane's own workspace block over the host's ORCA_PORT", () => {
    vi.stubEnv('ORCA_PORT', '3000')
    vi.stubEnv('CONDUCTOR_PORT', '3000')
    const env = createDaemonPtyEnvironment({
      sessionId: 's',
      cols: 80,
      rows: 24,
      env: { ORCA_PORT: '21010', ORCA_PORT_COUNT: '10', CONDUCTOR_PORT: '21010' }
    })
    expect([env.ORCA_PORT, env.ORCA_PORT_COUNT, env.CONDUCTOR_PORT]).toEqual([
      '21010',
      '10',
      '21010'
    ])
  })

  it("doesn't hand the host's block to a pane that has no workspace block", () => {
    vi.stubEnv('ORCA_PORT', '3000')
    vi.stubEnv('CONDUCTOR_PORT', '3000')
    const env = createDaemonPtyEnvironment({ sessionId: 's', cols: 80, rows: 24, env: {} })
    expect(env.ORCA_PORT).toBeUndefined()
    expect(env.CONDUCTOR_PORT).toBeUndefined()
  })
})
