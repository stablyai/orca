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

    diagnostics.firstStreamEvent('terminal-1', 1, 'subscribed')
    diagnostics.terminalUnsubscribed('terminal-1')
    diagnostics.firstStreamEvent('terminal-1', 1, 'subscribed')

    expect(log).toHaveBeenCalledTimes(2)
    log.mockRestore()
  })
})
