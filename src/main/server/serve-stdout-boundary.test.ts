import { describe, expect, it, vi } from 'vitest'
import { reserveServeStdoutForReadiness } from './serve-stdout-boundary'

describe('reserveServeStdoutForReadiness', () => {
  it('routes console diagnostics to stderr', () => {
    const target = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      log: vi.fn()
    }

    reserveServeStdoutForReadiness(target)
    target.debug('debug')
    target.info('info')
    target.log('log')

    expect(target.error.mock.calls).toEqual([['debug'], ['info'], ['log']])
  })
})
