import { describe, expect, it, vi } from 'vitest'
import { relayLogLine } from './relay-diagnostic-log'

describe('relayLogLine', () => {
  it('prefixes each log line with an ISO timestamp', () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      relayLogLine('[relay] Grace started (stdin ended)')

      expect(writeSpy).toHaveBeenCalledTimes(1)
      const line = writeSpy.mock.calls[0][0] as string
      // Why: relay.log correlation depends on a grep-stable
      // "<ISO timestamp> <original line>" shape (#7773).
      expect(line).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[relay\] Grace started \(stdin ended\)\n$/
      )
    } finally {
      writeSpy.mockRestore()
    }
  })
})
