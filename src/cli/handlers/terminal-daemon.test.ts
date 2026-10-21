import { describe, expect, it } from 'vitest'
import { formatSeveredDaemonStatus } from './terminal-daemon'

const live = {
  verdict: 'live' as const,
  pid: 4288,
  detail: 'answered its health check',
  processCeiling: {
    state: 'on' as const,
    limit: 200,
    mechanism: 'systemd-slice' as const,
    unit: 'orca_ptys_1.slice'
  }
}

describe('terminal-daemon status', () => {
  it('reports a live daemon and its process ceiling', () => {
    const text = formatSeveredDaemonStatus({ severed: null, daemon: live })
    expect(text).toContain('Terminal daemon: live (pid 4288)')
    expect(text).toContain('Terminal process ceiling: on (200 processes')
    expect(text).not.toContain('OK')
  })

  it('reports a ceiling that is off and why', () => {
    const text = formatSeveredDaemonStatus({
      severed: null,
      daemon: { ...live, processCeiling: { state: 'off', reason: 'no_user_manager' } }
    })
    expect(text).toContain('Terminal process ceiling: off (no user manager)')
  })

  it('never says OK for a daemon that is gone', () => {
    const text = formatSeveredDaemonStatus({
      severed: null,
      daemon: {
        verdict: 'exited',
        pid: 4288,
        detail: 'pid 4288 is gone; Orca starts a new daemon with the next terminal',
        processCeiling: null
      }
    })
    expect(text).toContain('Terminal daemon: exited')
    expect(text).toContain('next terminal')
    expect(text).not.toContain('OK')
    expect(text).not.toContain('ceiling')
  })

  it('reports unverifiable when the host cannot prove either way', () => {
    const text = formatSeveredDaemonStatus({
      severed: null,
      daemon: {
        verdict: 'unverifiable',
        pid: 4288,
        detail: 'it did not answer',
        processCeiling: null
      }
    })
    expect(text).toContain('Terminal daemon: unverifiable (pid 4288) — it did not answer')
  })

  it('says liveness is unverifiable against a host that does not report it', () => {
    const text = formatSeveredDaemonStatus({ severed: null })
    expect(text).toContain('unverifiable')
    expect(text).not.toContain('OK')
  })

  it('says a restart ends running processes and only resumable agents come back', () => {
    const text = formatSeveredDaemonStatus({
      severed: { pid: 4288, linuxStartTicks: '777', bootId: 'b', liveSessionCount: 3 },
      daemon: live
    })
    expect(text).toContain('PID 4288')
    expect(text).toContain('3 running terminals')
    expect(text).toContain('ENDS')
    expect(text).toContain('Agents that support resume can be resumed')
    expect(text).toContain('shells and other jobs cannot')
  })

  it('does not describe an exited severed daemon as still hosting terminals', () => {
    const text = formatSeveredDaemonStatus({
      severed: { pid: 4288, linuxStartTicks: '777', bootId: 'b', liveSessionCount: 0 },
      daemon: { verdict: 'exited', pid: 4288, detail: 'pid 4288 is gone', processCeiling: null }
    })
    expect(text).toContain('Terminal daemon: exited')
    expect(text).not.toContain('still hosts')
  })
})
