import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDaemonPtyEnvironment } from './spawn-environment'

afterEach(() => vi.unstubAllEnvs())

describe('daemon Codex preflight environment', () => {
  it('does not resurrect a launcher omitted by the current client', () => {
    vi.stubEnv('ORCA_CODEX_LAUNCH_PREFLIGHT', '/old-build/bin/orca')
    const env = createDaemonPtyEnvironment({ sessionId: 'test', cols: 80, rows: 24, env: {} })
    expect(env.ORCA_CODEX_LAUNCH_PREFLIGHT).toBeUndefined()
  })

  it('preserves the launcher explicitly verified by the current client', () => {
    vi.stubEnv('ORCA_CODEX_LAUNCH_PREFLIGHT', '/old-build/bin/orca')
    const env = createDaemonPtyEnvironment({
      sessionId: 'test',
      cols: 80,
      rows: 24,
      env: { ORCA_CODEX_LAUNCH_PREFLIGHT: '/current-build/bin/orca' }
    })
    expect(env.ORCA_CODEX_LAUNCH_PREFLIGHT).toBe('/current-build/bin/orca')
  })
})
