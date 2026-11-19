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

import { installStdioWriteErrorSink } from './main-process-error-guards'

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
