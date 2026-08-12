import { describe, expect, it } from 'vitest'
import { remoteCliRequestTimeoutMs } from './remote-cli-timeout'
import { MAX_TIMER_DELAY_MS } from '../shared/timer-delay'

describe('remoteCliRequestTimeoutMs', () => {
  it('gives Linear issue context reads the general CLI budget', () => {
    expect(
      remoteCliRequestTimeoutMs({
        argv: ['linear', 'issue', 'ENG-123', '--json']
      })
    ).toBe(300_000)
  })

  it('gives ordinary remote CLI requests the general CLI budget instead of the 30s relay default', () => {
    // Why: mutation commands bridged through the full host CLI (worktree
    // create, orchestration dispatch, ...) can legitimately exceed 30s.
    expect(remoteCliRequestTimeoutMs({ argv: ['status'] })).toBe(300_000)
    expect(remoteCliRequestTimeoutMs({ argv: ['worktree', 'create', '--repo', 'r'] })).toBe(300_000)
  })

  it('extends the timeout for wait-style commands', () => {
    expect(remoteCliRequestTimeoutMs({ argv: ['terminal', 'wait', '--for', 'exit'] })).toBe(600_000)
    expect(
      remoteCliRequestTimeoutMs({
        argv: ['orchestration', 'check', '--wait', '--json']
      })
    ).toBe(600_000)
    expect(
      remoteCliRequestTimeoutMs({
        argv: ['orchestration', 'ask', '--to', 'term_x', '--question', 'ok?']
      })
    ).toBe(780_000)
  })

  it('extends past an explicit --timeout-ms waiter budget', () => {
    expect(
      remoteCliRequestTimeoutMs({
        argv: ['terminal', 'wait', '--for', 'exit', '--timeout-ms', '1800000']
      })
    ).toBe(1_860_000)
    expect(
      remoteCliRequestTimeoutMs({
        argv: ['orchestration', 'check', '--wait', '--timeout-ms=1800000']
      })
    ).toBe(1_860_000)
  })

  it('keeps the wait base budget when --timeout-ms is small', () => {
    expect(
      remoteCliRequestTimeoutMs({
        argv: ['terminal', 'wait', '--for', 'exit', '--timeout-ms', '5000']
      })
    ).toBe(600_000)
  })

  it.each([
    [['--timeout-ms', String(Number.MAX_SAFE_INTEGER)], 1_980_000],
    [['--timeout-ms', String(Number.MAX_SAFE_INTEGER + 1)], 780_000],
    [['--timeout-ms', '9007199254740991.1'], 780_000],
    [['--timeout-ms', '1', '--timeout-ms=1800000'], 1_980_000],
    [['--timeout-ms=1800000', '--timeout-ms', '1'], 660_000],
    [['--timeout-ms', '1800000', '--timeout-ms'], 780_000],
    [['--timeout-ms=1800000', '--timeout-ms='], 780_000],
    [['--timeout-ms=1800000', '--timeout-ms', 'bad'], 780_000],
    [['--timeout-ms', 'bad', '--timeout-ms=1800000'], 1_980_000],
    [['--timeout-ms=bad', '--timeout-ms', '1800000'], 1_980_000]
  ])('bounds ask outer timers with last-wins flags %#', (timeoutArgs, expected) => {
    expect(
      remoteCliRequestTimeoutMs({
        argv: ['orchestration', 'ask', '--to', 'term_x', ...timeoutArgs]
      })
    ).toBe(expected)
  })

  it('does not apply the ask maximum to other wait commands', () => {
    expect(
      remoteCliRequestTimeoutMs({
        argv: ['terminal', 'wait', '--timeout-ms', '1800001']
      })
    ).toBe(1_860_001)
  })

  it.each(['+1000000', '1000000.0', '1e6'])(
    'extends non-ask waits using CLI-compatible integer syntax %s',
    (raw) => {
      expect(
        remoteCliRequestTimeoutMs({
          argv: ['terminal', 'wait', '--timeout-ms', raw]
        })
      ).toBe(1_060_000)
    }
  )

  it.each([
    ['Infinity'],
    ['1.5'],
    ['-1'],
    ['bad'],
    [String(Number.MAX_SAFE_INTEGER)],
    [String(MAX_TIMER_DELAY_MS - 60_000 + 1)]
  ])('falls back to the base budget when a non-ask --timeout-ms %s is unusable', (raw) => {
    expect(remoteCliRequestTimeoutMs({ argv: ['terminal', 'wait', '--timeout-ms', raw] })).toBe(
      600_000
    )
    expect(remoteCliRequestTimeoutMs({ argv: ['status', '--timeout-ms', raw] })).toBe(300_000)
  })

  it('keeps the largest non-ask budget that stays inside the timer range', () => {
    expect(
      remoteCliRequestTimeoutMs({
        argv: ['terminal', 'wait', '--timeout-ms', String(MAX_TIMER_DELAY_MS - 60_000)]
      })
    ).toBe(MAX_TIMER_DELAY_MS)
  })

  it('does not treat a flag value named wait as a command path element', () => {
    expect(remoteCliRequestTimeoutMs({ argv: ['terminal', 'read', '--terminal', 'wait'] })).toBe(
      300_000
    )
  })

  it('falls back to the relay default for malformed argv', () => {
    expect(remoteCliRequestTimeoutMs({ argv: 'status' })).toBeUndefined()
    expect(remoteCliRequestTimeoutMs({})).toBeUndefined()
  })
})
