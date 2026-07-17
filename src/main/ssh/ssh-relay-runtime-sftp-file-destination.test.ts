import { describe, expect, it, vi } from 'vitest'

import {
  openSshRelayRuntimeSftpFileDestination,
  type SshRelayRuntimeSftpFileOperations
} from './ssh-relay-runtime-sftp-file-destination'

type Callback = (error?: Error) => void

function createOperations(options: { mode?: number } = {}): {
  operations: SshRelayRuntimeSftpFileOperations
  events: string[]
  handle: Buffer
} {
  const handle = Buffer.from('owned-handle')
  const events: string[] = []
  const operations = {
    open: vi.fn(
      (
        _path: string,
        _flags: string,
        _attributes: { mode: number },
        callback: (error: Error | undefined, value: Buffer) => void
      ) => {
        events.push('open')
        callback(undefined, handle)
      }
    ),
    write: vi.fn(
      (
        _handle: Buffer,
        _buffer: Buffer,
        _offset: number,
        _length: number,
        _position: number,
        callback: Callback
      ) => {
        events.push('write')
        callback()
      }
    ),
    fchmod: vi.fn((_handle: Buffer, _mode: number, callback: Callback) => {
      events.push('fchmod')
      callback()
    }),
    fstat: vi.fn(
      (_handle: Buffer, callback: (error: Error | undefined, value: { mode: number }) => void) => {
        events.push('fstat')
        callback(undefined, { mode: options.mode ?? 0o100755 })
      }
    ),
    close: vi.fn((_handle: Buffer, callback: Callback) => {
      events.push('close')
      callback()
    }),
    unlink: vi.fn((_path: string, callback: Callback) => {
      events.push('unlink')
      callback()
    })
  } as unknown as SshRelayRuntimeSftpFileOperations
  return { operations, events, handle }
}

function openDestination(
  operations: SshRelayRuntimeSftpFileOperations,
  options: { signal?: AbortSignal; enforcePosixMode?: boolean; remotePath?: string } = {}
) {
  return openSshRelayRuntimeSftpFileDestination({
    operations,
    remotePath: options.remotePath ?? '/owned-staging/bin/node',
    mode: 0o755,
    enforcePosixMode: options.enforcePosixMode ?? true,
    signal: options.signal ?? new AbortController().signal
  })
}

describe('SSH relay runtime SFTP file destination', () => {
  it('opens exclusively and awaits each exact positional write callback', async () => {
    const { operations, handle } = createOperations()
    let firstCallback: Callback | undefined
    vi.mocked(operations.write).mockImplementationOnce(
      (_handle, _buffer, _offset, _length, _position, callback) => {
        firstCallback = callback
      }
    )

    const destination = await openDestination(operations)
    const firstChunk = Buffer.from('abc')
    let firstSettled = false
    const firstWrite = destination.write(firstChunk).then(() => {
      firstSettled = true
    })
    await Promise.resolve()
    expect(firstSettled).toBe(false)
    expect(operations.open).toHaveBeenCalledWith(
      '/owned-staging/bin/node',
      'wx',
      { mode: 0o755 },
      expect.any(Function)
    )
    expect(operations.write).toHaveBeenNthCalledWith(
      1,
      handle,
      firstChunk,
      0,
      3,
      0,
      expect.any(Function)
    )

    firstCallback?.()
    await firstWrite
    const secondChunk = Buffer.from('de')
    await destination.write(secondChunk)
    expect(operations.write).toHaveBeenNthCalledWith(
      2,
      handle,
      secondChunk,
      0,
      2,
      3,
      expect.any(Function)
    )
  })

  it('repairs and verifies exact POSIX mode before closing the owned handle', async () => {
    const { operations, events, handle } = createOperations()
    const destination = await openDestination(operations)
    await destination.close()

    expect(operations.fchmod).toHaveBeenCalledWith(handle, 0o755, expect.any(Function))
    expect(operations.fstat).toHaveBeenCalledWith(handle, expect.any(Function))
    expect(events).toEqual(['open', 'fchmod', 'fstat', 'close'])
  })

  it('skips POSIX mode operations only when the caller explicitly disables them', async () => {
    const { operations, events } = createOperations()
    const destination = await openDestination(operations, { enforcePosixMode: false })
    await destination.close()

    expect(events).toEqual(['open', 'close'])
    expect(operations.fchmod).not.toHaveBeenCalled()
    expect(operations.fstat).not.toHaveBeenCalled()
  })

  it('rejects a mode mismatch and removes the owned incomplete file on abort', async () => {
    const { operations, events } = createOperations({ mode: 0o100644 })
    const destination = await openDestination(operations)
    await expect(destination.close()).rejects.toThrow(/mode/i)
    await destination.abort(new Error('mode mismatch'))

    expect(events).toEqual(['open', 'fchmod', 'fstat', 'close', 'unlink'])
  })

  it.each(['fchmod', 'fstat'] as const)('fails closed when %s fails', async (operation) => {
    const { operations } = createOperations()
    vi.mocked(operations[operation]).mockImplementationOnce((...args: unknown[]) => {
      const callback = args.at(-1) as Callback
      callback(new Error(`${operation} failed`))
    })
    const destination = await openDestination(operations)

    await expect(destination.close()).rejects.toThrow(`${operation} failed`)
    await destination.abort(new Error(`${operation} failed`))
    expect(operations.close).toHaveBeenCalledOnce()
    expect(operations.unlink).toHaveBeenCalledOnce()
  })

  it('does not unlink a pre-existing file when exclusive open fails', async () => {
    const { operations } = createOperations()
    vi.mocked(operations.open).mockImplementationOnce((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error) => void
      callback(new Error('already exists'))
    })

    await expect(openDestination(operations)).rejects.toThrow('already exists')
    expect(operations.close).not.toHaveBeenCalled()
    expect(operations.unlink).not.toHaveBeenCalled()
  })

  it('rejects pre-open cancellation without creating a remote file', async () => {
    const { operations } = createOperations()
    const controller = new AbortController()
    controller.abort(new Error('cancelled before open'))

    await expect(openDestination(operations, { signal: controller.signal })).rejects.toThrow(
      'cancelled before open'
    )
    expect(operations.open).not.toHaveBeenCalled()
  })

  it('cleans an exclusively opened file when cancellation wins the open callback', async () => {
    const { operations, events, handle } = createOperations()
    const controller = new AbortController()
    vi.mocked(operations.open).mockImplementationOnce((...args: unknown[]) => {
      const callback = args.at(-1) as (error: undefined, value: Buffer) => void
      controller.abort(new Error('cancelled after open'))
      callback(undefined, handle)
    })

    await expect(openDestination(operations, { signal: controller.signal })).rejects.toThrow(
      'cancelled after open'
    )
    expect(events).toEqual(['close', 'unlink'])
  })

  it('joins cancellation to the in-flight write callback before cleanup', async () => {
    const { operations, events } = createOperations()
    const controller = new AbortController()
    let writeCallback: Callback | undefined
    vi.mocked(operations.write).mockImplementationOnce(
      (_handle, _buffer, _offset, _length, _position, callback) => {
        events.push('write')
        writeCallback = callback
      }
    )
    const destination = await openDestination(operations, { signal: controller.signal })
    let settled = false
    const write = destination.write(Buffer.from('bytes')).finally(() => {
      settled = true
    })

    controller.abort(new Error('cancelled during write'))
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(operations.close).not.toHaveBeenCalled()
    writeCallback?.()
    await expect(write).rejects.toThrow('cancelled during write')
    await destination.abort(controller.signal.reason)
    expect(events).toEqual(['open', 'write', 'close', 'unlink'])
  })

  it('propagates a write failure and then closes before unlinking', async () => {
    const { operations, events } = createOperations()
    vi.mocked(operations.write).mockImplementationOnce((...args: unknown[]) => {
      const callback = args.at(-1) as Callback
      events.push('write')
      callback(new Error('remote write failed'))
    })
    const destination = await openDestination(operations)

    await expect(destination.write(Buffer.from('bytes'))).rejects.toThrow('remote write failed')
    await destination.abort(new Error('remote write failed'))
    expect(events).toEqual(['open', 'write', 'close', 'unlink'])
  })

  it('joins close and unlink cleanup failures and makes abort idempotent', async () => {
    const { operations } = createOperations()
    vi.mocked(operations.close).mockImplementation((_handle, callback) =>
      callback(new Error('close cleanup failed'))
    )
    vi.mocked(operations.unlink).mockImplementation((_path, callback) =>
      callback(new Error('unlink cleanup failed'))
    )
    const destination = await openDestination(operations)

    const firstAbort = destination.abort(new Error('primary'))
    const secondAbort = destination.abort(new Error('secondary'))
    expect(firstAbort).toBe(secondAbort)
    await expect(firstAbort).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: 'close cleanup failed' }),
        expect.objectContaining({ message: 'unlink cleanup failed' })
      ]
    })
    expect(operations.close).toHaveBeenCalledOnce()
    expect(operations.unlink).toHaveBeenCalledOnce()
  })

  it('rejects empty, concurrent, and late writes with path-free diagnostics', async () => {
    const { operations } = createOperations()
    let writeCallback: Callback | undefined
    vi.mocked(operations.write).mockImplementationOnce(
      (_handle, _buffer, _offset, _length, _position, callback) => {
        writeCallback = callback
      }
    )
    const secretPath = '/home/private-user/staging/node'
    const destination = await openDestination(operations, { remotePath: secretPath })

    await expect(destination.write(Buffer.alloc(0))).rejects.not.toThrow(secretPath)
    const pending = destination.write(Buffer.from('first'))
    await expect(destination.write(Buffer.from('second'))).rejects.toThrow(/concurrent/i)
    writeCallback?.()
    await pending
    await destination.close()
    await expect(destination.write(Buffer.from('late'))).rejects.toThrow(/closed/i)
  })
})
