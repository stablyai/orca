import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDaemonPtyEnvironment } from '../../daemon/pty-subprocess/spawn-environment'
import { buildInheritedLocalPtyEnvironment } from '../../providers/local-pty/local-pty-spawn-environment'

function stubFigtermHost(): void {
  vi.stubEnv('Q_TERM', '2.27.1')
  vi.stubEnv('Q_TERM_TMUX', '2.27.1')
  vi.stubEnv('QTERM_SESSION_ID', 'c0ffee')
}

afterEach(() => vi.unstubAllEnvs())

describe('inherited figterm session env', () => {
  it('does not reach a local terminal when Orca was started inside figterm', () => {
    stubFigtermHost()

    const env = buildInheritedLocalPtyEnvironment({ QTERM_SESSION_ID: 'explicit-session' })

    expect(env.Q_TERM).toBeUndefined()
    expect(env.Q_TERM_TMUX).toBeUndefined()
    expect(env.QTERM_SESSION_ID).toBe('explicit-session')
  })

  it('does not reach a daemon terminal when the daemon was started inside figterm', () => {
    stubFigtermHost()

    const env = createDaemonPtyEnvironment({
      sessionId: 'new-terminal',
      cols: 80,
      rows: 24,
      env: { QTERM_SESSION_ID: 'explicit-session' }
    })

    expect(env.Q_TERM).toBeUndefined()
    expect(env.Q_TERM_TMUX).toBeUndefined()
    expect(env.QTERM_SESSION_ID).toBe('explicit-session')
  })
})
