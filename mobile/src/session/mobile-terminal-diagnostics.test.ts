import { describe, expect, it, vi } from 'vitest'
import {
  getMobileTerminalDiagnosticErrorName,
  logMobileTerminalDiagnostic,
  MobileTerminalDiagnostics,
  shortenMobileTerminalDiagnosticId
} from './mobile-terminal-diagnostics'

describe('mobile terminal diagnostics', () => {
  it('keeps only the correlatable suffix of identifiers', () => {
    expect(shortenMobileTerminalDiagnosticId('terminal-secret-prefix-12345678')).toBe('12345678')
    expect(shortenMobileTerminalDiagnosticId('short')).toBe('short')
    expect(shortenMobileTerminalDiagnosticId(null)).toBeNull()
  })

  it('reports thrown error types without copying potentially sensitive messages', () => {
    expect(getMobileTerminalDiagnosticErrorName(new TypeError('/private/worktree failed'))).toBe(
      'TypeError'
    )
    expect(getMobileTerminalDiagnosticErrorName('raw failure')).toBe('string')
  })

  it('uses one filterable structured log tag', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    logMobileTerminalDiagnostic('stream-armed', { handle: '12345678', seq: 2 })

    expect(log).toHaveBeenCalledWith('[terminal-diagnostic]', 'stream-armed', {
      handle: '12345678',
      seq: 2
    })
    log.mockRestore()
  })

  it('forgets first-event state when a terminal unsubscribes', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const diagnostics = new MobileTerminalDiagnostics()

    diagnostics.firstStreamEvent('terminal-1', 1, { type: 'subscribed' })
    diagnostics.terminalUnsubscribed('terminal-1')
    diagnostics.firstStreamEvent('terminal-1', 1, { type: 'subscribed' })

    expect(log).toHaveBeenCalledTimes(2)
    log.mockRestore()
  })

  it('measures lease-only acknowledgement latency', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000)
      const diagnostics = new MobileTerminalDiagnostics()

      diagnostics.streamArmed('terminal-1', 3, null, true)
      vi.setSystemTime(1_275)
      diagnostics.firstStreamEvent('terminal-1', 3, {
        type: 'subscribed',
        readinessTiming: { serverTotalMs: 200, ptyWaitMs: 180, leaseRegisterMs: 5 }
      })

      expect(log).toHaveBeenLastCalledWith('[terminal-diagnostic]', 'stream-first-event', {
        handle: 'rminal-1',
        seq: 3,
        type: 'subscribed',
        leaseOnly: true,
        waitMs: 275,
        serverTotalMs: 200,
        serverPtyWaitMs: 180,
        serverLeaseRegisterMs: 5,
        estimatedTransportMs: 75
      })
    } finally {
      vi.useRealTimers()
      log.mockRestore()
    }
  })
})
