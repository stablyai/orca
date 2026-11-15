import { describe, expect, it, vi } from 'vitest'
import type { TerminalExitCause } from '../../../../shared/terminal/pty/lifecycle/terminal-exit-cause'
import { recordTerminalHostSessionExit } from '../terminal-host-session-exit'

function logUnattachedExit(exitCause: TerminalExitCause): unknown {
  const log = vi.fn()
  recordTerminalHostSessionExit(
    'pane-1',
    {
      hasAttachedClients: false,
      exitCode: 0,
      exitCause,
      incarnationId: '00000000-0000-4000-8000-000000000001',
      wslDistro: null
    },
    new Map(),
    log
  )
  expect(log).toHaveBeenCalledTimes(1)
  return log.mock.calls[0]
}

// #42383: node-pty reports code 0 for signal deaths, which made an OS restart read as clean exits.
describe('unattached session-exited log line', () => {
  it('names the signal that killed the session', () => {
    expect(logUnattachedExit({ kind: 'signaled', signal: 15 })).toEqual([
      'session-exited',
      { sessionId: 'pane-1', code: 0, cause: 'signaled', signal: 15, attached: false }
    ])
  })

  it('marks daemon-initiated teardown apart from a shell exit', () => {
    expect(logUnattachedExit({ kind: 'operator_close' })).toEqual([
      'session-exited',
      { sessionId: 'pane-1', code: 0, cause: 'operator_close', attached: false }
    ])
  })

  it('keeps why the cause is unknown when the host cannot report it', () => {
    expect(logUnattachedExit({ kind: 'unknown', reason: 'host_status_unavailable' })).toEqual([
      'session-exited',
      {
        sessionId: 'pane-1',
        code: 0,
        cause: 'unknown',
        reason: 'host_status_unavailable',
        attached: false
      }
    ])
  })
})
