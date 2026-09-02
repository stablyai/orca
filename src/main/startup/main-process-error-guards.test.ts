import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('main-process fatal error guards (issue #9441)', () => {
  it('records unhandled rejections durably and keeps the process alive', async () => {
    vi.resetModules()
    const record = vi.fn()
    vi.doMock('../crash-reporting/durable-crash-breadcrumb', () => ({
      recordDurableCrashBreadcrumb: record
    }))
    const { installUnhandledRejectionLogging } = await import('./main-process-error-guards')
    const before = process.listeners('unhandledRejection').length
    installUnhandledRejectionLogging()
    const listeners = process.listeners('unhandledRejection')
    expect(listeners.length).toBe(before + 1)
    const listener = listeners.at(-1) as (reason: unknown, promise: Promise<unknown>) => void
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      // Why: invoking the listener directly must not throw — a throwing handler would still kill main.
      expect(() =>
        listener(Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN' }), Promise.resolve())
      ).not.toThrow()
    } finally {
      process.removeListener('unhandledRejection', listener as never)
      consoleError.mockRestore()
    }
    expect(record).toHaveBeenCalledWith(
      'main_unhandled_rejection',
      expect.objectContaining({ errorMessage: 'spawn EAGAIN', errorCode: 'EAGAIN' }),
      'main_unhandled_rejection'
    )
  })

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

  it('keeps absent optional error fields empty', async () => {
    vi.resetModules()
    const record = vi.fn()
    vi.doMock('../crash-reporting/durable-crash-breadcrumb', () => ({
      recordDurableCrashBreadcrumb: record
    }))
    const { recordFatalMainProcessError } = await import('./main-process-error-guards')
    vi.spyOn(console, 'error').mockImplementation(() => {})

    recordFatalMainProcessError('main_unhandled_rejection', new Error('boom'))

    expect(record).toHaveBeenCalledWith(
      'main_unhandled_rejection',
      expect.objectContaining({ errorMessage: 'boom', errorCode: '' }),
      'main_unhandled_rejection'
    )
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

  it('caps a rejection storm and carries the suppressed count into the next window', async () => {
    vi.resetModules()
    const record = vi.fn()
    vi.doMock('../crash-reporting/durable-crash-breadcrumb', () => ({
      recordDurableCrashBreadcrumb: record
    }))
    const { recordFatalMainProcessError } = await import('./main-process-error-guards')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)

    for (let i = 0; i < 25; i++) {
      recordFatalMainProcessError('main_unhandled_rejection', new Error(`storm ${i}`))
    }
    expect(record).toHaveBeenCalledTimes(20)

    now += 60_000
    recordFatalMainProcessError('main_unhandled_rejection', new Error('after window'))
    expect(record).toHaveBeenCalledTimes(21)
    expect(record).toHaveBeenLastCalledWith(
      'main_unhandled_rejection',
      expect.objectContaining({ errorMessage: 'after window', suppressedSinceLast: 5 }),
      'main_unhandled_rejection'
    )
  })

  it('reopens the window when the wall clock jumps backwards after exhaustion', async () => {
    vi.resetModules()
    const record = vi.fn()
    vi.doMock('../crash-reporting/durable-crash-breadcrumb', () => ({
      recordDurableCrashBreadcrumb: record
    }))
    const { recordFatalMainProcessError } = await import('./main-process-error-guards')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)

    for (let i = 0; i < 25; i++) {
      recordFatalMainProcessError('main_unhandled_rejection', new Error(`storm ${i}`))
    }
    expect(record).toHaveBeenCalledTimes(20)

    // Why: a backward jump must not trap the exhausted window and suppress every later breadcrumb.
    now -= 3_600_000
    recordFatalMainProcessError('main_unhandled_rejection', new Error('after backward jump'))
    expect(record).toHaveBeenCalledTimes(21)
    expect(record).toHaveBeenLastCalledWith(
      'main_unhandled_rejection',
      expect.objectContaining({ errorMessage: 'after backward jump', suppressedSinceLast: 5 }),
      'main_unhandled_rejection'
    )
  })

  it('never suppresses the fatal uncaught-exception record after a rejection storm', async () => {
    vi.resetModules()
    const record = vi.fn()
    vi.doMock('../crash-reporting/durable-crash-breadcrumb', () => ({
      recordDurableCrashBreadcrumb: record
    }))
    const { recordFatalMainProcessError } = await import('./main-process-error-guards')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000)

    for (let i = 0; i < 25; i++) {
      recordFatalMainProcessError('main_unhandled_rejection', new Error(`storm ${i}`))
    }
    expect(record).toHaveBeenCalledTimes(20)

    // Why: this record precedes the re-throw that kills main; losing it would recreate issue #9441.
    recordFatalMainProcessError('main_uncaught_exception', new Error('fatal after storm'))
    expect(record).toHaveBeenCalledTimes(21)
    expect(record).toHaveBeenLastCalledWith(
      'main_uncaught_exception',
      expect.objectContaining({ errorMessage: 'fatal after storm', suppressedSinceLast: 5 }),
      'main_uncaught_exception'
    )
  })

  it('keeps uncaught pipe errors swallowed without a durable record', async () => {
    vi.resetModules()
    const record = vi.fn()
    vi.doMock('../crash-reporting/durable-crash-breadcrumb', () => ({
      recordDurableCrashBreadcrumb: record
    }))
    const { installUncaughtPipeErrorGuard } = await import('./main-process-error-guards')
    const before = process.listeners('uncaughtException').length
    installUncaughtPipeErrorGuard()
    const listeners = process.listeners('uncaughtException')
    expect(listeners.length).toBe(before + 1)
    const listener = listeners.at(-1) as (error: unknown) => void
    try {
      listener(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    } finally {
      process.removeListener('uncaughtException', listener as never)
    }
    // Why: EPIPE/EIO are expected pipe churn; recording them would flood the breadcrumb store.
    expect(record).not.toHaveBeenCalled()
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
