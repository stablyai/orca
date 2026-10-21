import { describe, expect, it, vi } from 'vitest'
import {
  emitServeBrowserIdentityActionLine,
  reserveServeStdoutForReadiness
} from './serve-stdout-boundary'

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

describe('emitServeBrowserIdentityActionLine', () => {
  it.each([
    {
      state: 'valid' as const,
      migrationNotice: { degraded: false },
      expected: 'choose Cleaned or Native'
    },
    {
      state: 'valid' as const,
      migrationNotice: { degraded: true },
      expected: 'old choice could not be inspected'
    },
    { state: 'corrupt' as const, migrationNotice: null, expected: 'reset it explicitly' },
    { state: 'future' as const, migrationNotice: null, expected: 'update Orca' }
  ])('writes one stderr action for $state', ({ state, migrationNotice, expected }) => {
    const write = vi.fn()
    const identity =
      state === 'valid'
        ? {
            state,
            appliedMode: 'clean' as const,
            configuredMode: 'clean' as const,
            explicitSelection: false,
            migrationNoticePending: true,
            restartRequired: false
          }
        : {
            state,
            appliedMode: 'clean' as const,
            configuredMode: null,
            explicitSelection: null,
            migrationNoticePending: null,
            restartRequired: false as const
          }

    emitServeBrowserIdentityActionLine({ identity, migrationNotice }, { write })

    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith(expect.stringContaining(expected))
  })
})
