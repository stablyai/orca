import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('main-process fatal error guards (issue #9441)', () => {
  it('never throws when the breadcrumb sink fails', async () => {
    vi.resetModules()
    vi.doMock('../crash-reporting/durable-crash-breadcrumb', () => ({
      recordDurableCrashBreadcrumb: vi.fn(() => {
        throw new Error('sink offline')
      })
    }))
    const { recordFatalMainProcessError } = await import('./main-process-error-guards')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() =>
        recordFatalMainProcessError('main_uncaught_exception', 'not-an-error')
      ).not.toThrow()
    } finally {
      consoleError.mockRestore()
    }
  })

  it('bounds and isolates console formatting for hostile rejection values', async () => {
    vi.resetModules()
    const record = vi.fn()
    vi.doMock('../crash-reporting/durable-crash-breadcrumb', () => ({
      recordDurableCrashBreadcrumb: record
    }))
    const { recordFatalMainProcessError } = await import('./main-process-error-guards')
    const hostileReason = {
      toString(): never {
        throw new Error('toString failed')
      },
      [Symbol.for('nodejs.util.inspect.custom')](): never {
        throw new Error('inspect failed')
      }
    }
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
      if (values.some((value) => typeof value !== 'string')) {
        throw new Error('unsafe console formatting')
      }
    })

    expect(() =>
      recordFatalMainProcessError('main_unhandled_rejection', hostileReason)
    ).not.toThrow()
    expect(record).toHaveBeenCalledWith(
      'main_unhandled_rejection',
      expect.objectContaining({ errorName: 'object', errorMessage: '[unprintable value]' }),
      'main_unhandled_rejection'
    )
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringMatching(/^\[main_unhandled_rejection\]/)
    )
    expect(String(consoleError.mock.calls[0]?.[0]).length).toBeLessThan(5_000)
  })

  it('caps oversized rejection diagnostics before recording or logging', async () => {
    vi.resetModules()
    const record = vi.fn()
    vi.doMock('../crash-reporting/durable-crash-breadcrumb', () => ({
      recordDurableCrashBreadcrumb: record
    }))
    const { recordFatalMainProcessError } = await import('./main-process-error-guards')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const error = Object.assign(new Error('m'.repeat(100_000)), { code: 'c'.repeat(100_000) })
    error.name = 'n'.repeat(100_000)
    error.stack = Array.from({ length: 100 }, () => 's'.repeat(1_000)).join('\n')

    recordFatalMainProcessError('main_unhandled_rejection', error)

    const details = record.mock.calls[0]?.[1] as Record<string, string>
    expect(details.errorName).toHaveLength(100)
    expect(details.errorMessage).toHaveLength(500)
    expect(details.errorStack.length).toBeLessThanOrEqual(4_000)
    expect(details.errorCode).toHaveLength(100)
    expect(String(consoleError.mock.calls[0]?.[0]).length).toBeLessThan(5_000)
  })

  it('rethrows non-pipe errors outside the uncaughtException handler', async () => {
    vi.resetModules()
    vi.doMock('../crash-reporting/durable-crash-breadcrumb', () => ({
      recordDurableCrashBreadcrumb: vi.fn()
    }))
    const { installUncaughtPipeErrorGuard } = await import('./main-process-error-guards')
    const originalOn = process.on.bind(process)
    const originalOff = process.off.bind(process)
    let handler: ((error: unknown) => void) | null = null
    let scheduled: (() => void) | null = null
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(process, 'on').mockImplementation(((event, listener) => {
      if (event === 'uncaughtException') {
        handler = listener as (error: unknown) => void
        return process
      }
      return originalOn(event, listener)
    }) as typeof process.on)
    const offSpy = vi.spyOn(process, 'off').mockImplementation(((event, listener) => {
      if (event === 'uncaughtException') {
        return process
      }
      return originalOff(event, listener)
    }) as typeof process.off)
    vi.spyOn(globalThis, 'setImmediate').mockImplementation(((callback) => {
      scheduled = callback as () => void
      return {} as NodeJS.Immediate
    }) as typeof setImmediate)

    installUncaughtPipeErrorGuard()

    const error = new Error('boom')
    expect(() => handler?.(error)).not.toThrow()
    expect(offSpy).toHaveBeenCalledWith('uncaughtException', handler)
    expect(scheduled).not.toBeNull()
    expect(() => scheduled?.()).toThrow(error)
  })
})
