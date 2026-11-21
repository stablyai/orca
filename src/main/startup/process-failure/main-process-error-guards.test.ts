import { createWriteStream, openSync, type WriteStream } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Console } from 'node:console'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { recordDurableCrashBreadcrumbMock } = vi.hoisted(() => ({
  recordDurableCrashBreadcrumbMock: vi.fn()
}))

vi.mock('../../crash-reporting/breadcrumbs/durable-crash-breadcrumb', () => ({
  recordDurableCrashBreadcrumb: recordDurableCrashBreadcrumbMock
}))
vi.mock('./fatal-exception-quit', () => ({ quitAfterFatalException: vi.fn() }))

import {
  installStdioWriteErrorSink,
  installUncaughtExceptionQuitGuard
} from './main-process-error-guards'

describe('installStdioWriteErrorSink', () => {
  let root: string
  let file: string

  function closed(stream: WriteStream): Promise<void> {
    return new Promise((resolve) => stream.once('close', () => resolve()))
  }

  function deadLogStream(): WriteStream {
    // Writes to a read-only descriptor fail like a full or dead log target.
    return createWriteStream(file, { fd: openSync(file, 'r') })
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-stdio-sink-'))
    file = join(root, 'log')
    await writeFile(file, '')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
    recordDurableCrashBreadcrumbMock.mockReset()
  })

  it('absorbs a real console write failure on a dead stdout', async () => {
    const stdout = deadLogStream()
    installStdioWriteErrorSink([['stdout', stdout]])
    const logger = new Console({ stdout, stderr: stdout })

    logger.info('[runtime-rpc] client connected', { deviceId: 'a' })
    await closed(stdout)

    expect(recordDurableCrashBreadcrumbMock).toHaveBeenCalledWith(
      'main_stdio_write_failed',
      expect.objectContaining({ stream: 'stdout', errorCode: expect.stringMatching(/^E/) })
    )
  })

  it('records the raw errno when libuv cannot name the failure, and survives the next one', () => {
    const stdout = deadLogStream()
    installStdioWriteErrorSink([['stdout', stdout]])
    const quotaExceeded = Object.assign(new Error('UNKNOWN: unknown error, write'), {
      code: 'UNKNOWN',
      errno: -122
    })

    stdout.emit('error', quotaExceeded)
    // Stdio stays writable after a failure, so the next console write can fail again.
    expect(() => stdout.emit('error', quotaExceeded)).not.toThrow()

    expect(recordDurableCrashBreadcrumbMock).toHaveBeenCalledWith('main_stdio_write_failed', {
      stream: 'stdout',
      errorCode: 'UNKNOWN',
      errno: '-122'
    })
  })

  it('stays silent when recording the breadcrumb also fails', async () => {
    const stderr = deadLogStream()
    installStdioWriteErrorSink([['stderr', stderr]])
    recordDurableCrashBreadcrumbMock.mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device, write')
    })

    stderr.write('diagnostic line\n')
    await closed(stderr)

    expect(stderr.errored).toMatchObject({ code: expect.stringMatching(/^E/) })
  })
})

const originalListeners = process.listeners('uncaughtException')

function guardListener(): NodeJS.UncaughtExceptionListener | undefined {
  return process
    .listeners('uncaughtException')
    .find((listener) => !originalListeners.includes(listener))
}

function fire(error: Error): void {
  const listener = guardListener()
  if (!listener) {
    throw new Error('uncaughtException guard is not installed')
  }
  listener(error, 'uncaughtException')
}

describe('installUncaughtExceptionQuitGuard', () => {
  afterEach(() => {
    for (const listener of process.listeners('uncaughtException')) {
      if (!originalListeners.includes(listener)) {
        process.removeListener('uncaughtException', listener)
      }
    }
    recordDurableCrashBreadcrumbMock.mockReset()
  })

  it('records the error once and quits once instead of leaving it to the modal handler', () => {
    const quit = vi.fn()
    installUncaughtExceptionQuitGuard(quit)

    fire(new TypeError('boom'))
    fire(new TypeError('during teardown'))

    expect(quit).toHaveBeenCalledTimes(1)
    expect(recordDurableCrashBreadcrumbMock).toHaveBeenCalledTimes(1)
    expect(recordDurableCrashBreadcrumbMock).toHaveBeenCalledWith(
      'main_uncaught_exception',
      expect.objectContaining({ errorName: 'TypeError', errorMessage: 'boom' }),
      'main_uncaught_exception'
    )
    expect(guardListener()).toBeDefined()
  })

  it('keeps running after a broken pipe or a dead local PTY', () => {
    const quit = vi.fn()
    installUncaughtExceptionQuitGuard(quit)

    fire(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    fire(new Error('Pty process exited'))

    expect(quit).not.toHaveBeenCalled()
  })

  it('still quits when inspecting the error throws', () => {
    const quit = vi.fn()
    installUncaughtExceptionQuitGuard(quit)
    const hostile = Object.defineProperty(new Error('real fault'), 'name', {
      get() {
        throw new Error('name getter failed')
      }
    })

    fire(hostile)

    expect(quit).toHaveBeenCalled()
  })
})
