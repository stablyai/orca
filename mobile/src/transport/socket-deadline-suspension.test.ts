import { describe, expect, it } from 'vitest'
import { describeSocketDeadline } from './socket-deadline-suspension'

describe('socket deadline diagnostics', () => {
  it.each([
    { kind: 'connect', timeoutMs: 12_000, code: 'connect-timeout' },
    { kind: 'handshake', timeoutMs: 5_000, code: 'handshake-timeout' }
  ] as const)(
    'keeps ordinary $kind deadlines through the grace boundary',
    ({ kind, timeoutMs, code }) => {
      const report = describeSocketDeadline({ kind, timeoutMs, elapsedMs: timeoutMs + 60_000 })
      expect(report).toMatchObject({ suspended: false, level: 'error', code })
    }
  )

  it('classifies the reported 2h44m connect gap as suspension', () => {
    const report = describeSocketDeadline({
      kind: 'connect',
      timeoutMs: 12_000,
      elapsedMs: Date.parse('2026-09-04T15:40:52.242Z') - Date.parse('2026-09-04T12:56:55.512Z')
    })
    expect(report).toMatchObject({
      suspended: true,
      level: 'warn',
      code: 'suspended-dial',
      detail:
        'Connection deadline delayed for 2h44m; app may have been suspended. Connection state unknown, re-dialing'
    })
    expect(report.detail).not.toContain('endpoint unreachable')
  })

  it('classifies a handshake timer beyond the grace boundary as suspension', () => {
    const report = describeSocketDeadline({
      kind: 'handshake',
      timeoutMs: 5_000,
      elapsedMs: 65_001
    })
    expect(report).toMatchObject({
      suspended: true,
      code: 'suspended-dial',
      title: 'Handshake interrupted'
    })
  })
})
