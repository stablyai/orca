import { afterEach, describe, expect, it, vi } from 'vitest'

const { recordDurableCrashBreadcrumbMock } = vi.hoisted(() => ({
  recordDurableCrashBreadcrumbMock: vi.fn()
}))

vi.mock('../../crash-reporting/breadcrumbs/durable-crash-breadcrumb', () => ({
  recordDurableCrashBreadcrumb: recordDurableCrashBreadcrumbMock
}))

import { installStdioWriteErrorSink } from './main-process-error-guards'

const originalStdoutListeners = process.stdout.listeners('error')
const originalStderrListeners = process.stderr.listeners('error')

function restoreErrorListeners(stream: NodeJS.WriteStream, original: unknown[]): void {
  for (const listener of stream.listeners('error')) {
    if (!original.includes(listener)) {
      stream.removeListener('error', listener as (...args: unknown[]) => void)
    }
  }
}

describe('installStdioWriteErrorSink', () => {
  afterEach(() => {
    restoreErrorListeners(process.stdout, originalStdoutListeners)
    restoreErrorListeners(process.stderr, originalStderrListeners)
    recordDurableCrashBreadcrumbMock.mockReset()
  })

  it('absorbs a failed stdout write that libuv cannot name, recording it once', () => {
    installStdioWriteErrorSink()
    const quotaExceeded = Object.assign(new Error('UNKNOWN: unknown error, write'), {
      code: 'UNKNOWN',
      errno: -122,
      syscall: 'write'
    })

    expect(() => {
      process.stdout.emit('error', quotaExceeded)
      process.stdout.emit('error', quotaExceeded)
    }).not.toThrow()
    expect(recordDurableCrashBreadcrumbMock).toHaveBeenCalledTimes(1)
    expect(recordDurableCrashBreadcrumbMock).toHaveBeenCalledWith('main_stdio_write_failed', {
      stream: 'stdout',
      errorCode: 'UNKNOWN',
      errno: '-122'
    })
  })

  it('absorbs a failed stderr write even when recording the breadcrumb fails', () => {
    installStdioWriteErrorSink()
    recordDurableCrashBreadcrumbMock.mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device, write')
    })

    expect(() =>
      process.stderr.emit(
        'error',
        Object.assign(new Error('EIO: i/o error, write'), { code: 'EIO' })
      )
    ).not.toThrow()
  })
})
