import { describe, expect, it, vi } from 'vitest'
import { reserveServeStdoutForReadiness } from './serve-stdout-boundary'

describe('reserveServeStdoutForReadiness', () => {
  // #40328: unstamped serve diagnostics could not be lined up with daemon or kernel logs.
  it('sends diagnostics to stderr with an ISO timestamp', () => {
    const target = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), log: vi.fn(), warn: vi.fn() }
    const { error, warn } = target
    const stamp = new Date('2026-11-09T12:00:00.000Z')

    reserveServeStdoutForReadiness(target, () => stamp)
    target.log('[runtime] client connected', { clientId: 'device-1' })
    target.warn('[daemon] exited', 'SIGABRT')

    expect(error).toHaveBeenCalledWith('2026-11-09T12:00:00.000Z', '[runtime] client connected', {
      clientId: 'device-1'
    })
    expect(warn).toHaveBeenCalledWith('2026-11-09T12:00:00.000Z', '[daemon] exited', 'SIGABRT')
  })
})
