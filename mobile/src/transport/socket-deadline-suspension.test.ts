import { describe, expect, it, vi } from 'vitest'
import { describeSocketDeadline, reportSocketDeadline } from './socket-deadline-suspension'

const CONNECT_TIMEOUT_MS = 12_000
const HANDSHAKE_TIMEOUT_MS = 5_000
const SUSPENSION_SLACK_MS = 60_000

describe('describeSocketDeadline', () => {
  it('keeps a deadline that fires on its budget as a host timeout', () => {
    const armedAtMs = 1_000
    const report = describeSocketDeadline({
      kind: 'connect',
      armedAtMs,
      firedAtMs: armedAtMs + CONNECT_TIMEOUT_MS,
      timeoutMs: CONNECT_TIMEOUT_MS,
      attempt: 2
    })

    expect(report).toMatchObject({
      suspended: false,
      level: 'error',
      code: 'connect-timeout',
      title: 'WebSocket connect timeout',
      detail: 'No TCP/WS handshake within 12s — endpoint unreachable?',
      consoleMessage: '[net] connect-timeout fired (onopen never arrived)'
    })
  })

  it('does not classify an on-budget deadline as suspension after foreground loss', () => {
    const report = describeSocketDeadline({
      kind: 'connect',
      armedAtMs: 1_000,
      firedAtMs: 1_000 + CONNECT_TIMEOUT_MS,
      timeoutMs: CONNECT_TIMEOUT_MS,
      monotonicElapsedMs: CONNECT_TIMEOUT_MS,
      leftForeground: true
    })

    expect(report.suspended).toBe(false)
    expect(report.code).toBe('connect-timeout')
  })

  it('keeps a handshake that fires just past its budget as a handshake timeout', () => {
    const armedAtMs = 5_000
    const report = describeSocketDeadline({
      kind: 'handshake',
      armedAtMs,
      firedAtMs: armedAtMs + HANDSHAKE_TIMEOUT_MS + SUSPENSION_SLACK_MS,
      timeoutMs: HANDSHAKE_TIMEOUT_MS
    })

    expect(report.suspended).toBe(false)
    expect(report.code).toBe('handshake-timeout')
    expect(report.detail).toBe('No e2ee_ready/e2ee_authenticated within 5s')
  })

  it('treats a timer that fires hours late as suspension, not an unreachable host', () => {
    const armedAtMs = Date.parse('2026-09-04T12:56:55.512Z')
    const firedAtMs = Date.parse('2026-09-04T15:40:52.242Z')
    const report = describeSocketDeadline({
      kind: 'connect',
      armedAtMs,
      firedAtMs,
      timeoutMs: CONNECT_TIMEOUT_MS,
      attempt: 2
    })

    expect(report).toMatchObject({
      suspended: true,
      level: 'warn',
      code: 'suspended-dial',
      title: 'WebSocket connect interrupted',
      detail: 'App suspended for 2h44m; connection state unknown, re-dialing'
    })
    expect(report.detail).not.toContain('endpoint unreachable')
    expect(report.consoleMessage).not.toContain('connect-timeout')
  })

  it('keeps a wall-clock jump as a host timeout when the monotonic clock stays on budget', () => {
    const armedAtMs = 1_000
    const report = describeSocketDeadline({
      kind: 'connect',
      armedAtMs,
      firedAtMs: armedAtMs + 3 * 60 * 60 * 1000,
      timeoutMs: CONNECT_TIMEOUT_MS,
      monotonicElapsedMs: CONNECT_TIMEOUT_MS,
      leftForeground: false
    })

    expect(report.suspended).toBe(false)
    expect(report.code).toBe('connect-timeout')
  })

  it('does not treat foreground loss and a backward wall-clock step as suspension alone', () => {
    const armedAtMs = 50_000
    const report = describeSocketDeadline({
      kind: 'connect',
      armedAtMs,
      firedAtMs: armedAtMs - 5_000,
      timeoutMs: CONNECT_TIMEOUT_MS,
      monotonicElapsedMs: CONNECT_TIMEOUT_MS,
      leftForeground: true
    })

    expect(report.suspended).toBe(false)
    expect(report.code).toBe('connect-timeout')
    expect(report.detail).toContain('endpoint unreachable')
  })

  it('reads suspension when the wall clock and the monotonic clock both run long', () => {
    const armedAtMs = 0
    const report = describeSocketDeadline({
      kind: 'connect',
      armedAtMs,
      firedAtMs: CONNECT_TIMEOUT_MS + SUSPENSION_SLACK_MS + 1,
      timeoutMs: CONNECT_TIMEOUT_MS,
      monotonicElapsedMs: CONNECT_TIMEOUT_MS + SUSPENSION_SLACK_MS + 1,
      leftForeground: false
    })

    expect(report.code).toBe('suspended-dial')
    expect(report.detail).toContain('App suspended for')
  })

  it('uses the same suspension reading for a frozen handshake timer', () => {
    const armedAtMs = 0
    const report = describeSocketDeadline({
      kind: 'handshake',
      armedAtMs,
      firedAtMs: HANDSHAKE_TIMEOUT_MS + SUSPENSION_SLACK_MS + 1,
      timeoutMs: HANDSHAKE_TIMEOUT_MS
    })

    expect(report.code).toBe('suspended-dial')
    expect(report.title).toBe('Handshake interrupted')
    expect(report.detail).not.toContain('handshake timeout')
  })
})

describe('reportSocketDeadline', () => {
  it('still closes the socket after logging a suspended dial', () => {
    const emitLog = vi.fn()
    const close = vi.fn()

    reportSocketDeadline(
      {
        kind: 'connect',
        armedAtMs: 0,
        firedAtMs: CONNECT_TIMEOUT_MS + SUSPENSION_SLACK_MS + 1,
        timeoutMs: CONNECT_TIMEOUT_MS
      },
      emitLog,
      close
    )

    expect(emitLog).toHaveBeenCalledWith(
      'warn',
      'WebSocket connect interrupted',
      expect.stringContaining('connection state unknown, re-dialing'),
      { code: 'suspended-dial' }
    )
    expect(close).toHaveBeenCalledOnce()
  })
})
