import { EventEmitter } from 'node:events'

import type { SFTPWrapper } from 'ssh2'
import { describe, expect, it, vi } from 'vitest'

import { openSshRelayRuntimeSftpTreeSession } from './ssh-relay-runtime-sftp-session'

type Callback = (error?: Error) => void

function createRawSession() {
  const emitter = new EventEmitter()
  const raw = Object.assign(emitter, {
    mkdir: vi.fn(function (this: unknown, _path: string, _attributes: unknown, callback: Callback) {
      callback()
    }),
    rmdir: vi.fn(function (this: unknown, _path: string, callback: Callback) {
      callback()
    }),
    open: vi.fn(function (
      this: unknown,
      _path: string,
      _flags: string,
      _attributes: unknown,
      callback: (error: Error | undefined, handle: Buffer) => void
    ) {
      callback(undefined, Buffer.from('handle'))
    }),
    write: vi.fn(function (
      this: unknown,
      _handle: Buffer,
      _buffer: Buffer,
      _offset: number,
      _length: number,
      _position: number,
      callback: Callback
    ) {
      callback()
    }),
    fchmod: vi.fn(function (this: unknown, _handle: Buffer, _mode: number, callback: Callback) {
      callback()
    }),
    fstat: vi.fn(function (
      this: unknown,
      _handle: Buffer,
      callback: (error: Error | undefined, value: { mode: number }) => void
    ) {
      callback(undefined, { mode: 0o100755 })
    }),
    close: vi.fn(function (this: unknown, _handle: Buffer, callback: Callback) {
      callback()
    }),
    unlink: vi.fn(function (this: unknown, _path: string, callback: Callback) {
      callback()
    }),
    end: vi.fn()
  }) as unknown as SFTPWrapper
  return raw
}

function openSession(
  raw: SFTPWrapper,
  options: {
    signal?: AbortSignal
    forceCloseConnection?: (reason: unknown) => Promise<void>
  } = {}
) {
  const signal = options.signal ?? new AbortController().signal
  const openRawSession = vi.fn(async (receivedSignal: AbortSignal) => {
    expect(receivedSignal).toBe(signal)
    return raw
  })
  const forceCloseConnection = vi.fn(options.forceCloseConnection ?? (async () => {}))
  return {
    opened: openSshRelayRuntimeSftpTreeSession({
      signal,
      openRawSession,
      forceCloseConnection
    }),
    openRawSession,
    forceCloseConnection
  }
}

describe('SSH relay runtime raw SFTP session adapter', () => {
  it('forwards the exact signal and binds every operation to the raw session', async () => {
    const raw = createRawSession()
    const { opened, openRawSession } = openSession(raw)
    const session = await opened
    const callback = vi.fn()

    session.operations.mkdir('/stage', { mode: 0o700 }, callback)
    session.operations.rmdir('/stage', callback)
    session.operations.open('/stage/node', 'wx', { mode: 0o755 }, callback)
    session.operations.write(Buffer.from('h'), Buffer.from('x'), 0, 1, 0, callback)
    session.operations.fchmod(Buffer.from('h'), 0o755, callback)
    session.operations.fstat(Buffer.from('h'), callback)
    session.operations.close(Buffer.from('h'), callback)
    session.operations.unlink('/stage/node', callback)

    expect(openRawSession).toHaveBeenCalledOnce()
    for (const operation of [
      raw.mkdir,
      raw.rmdir,
      raw.open,
      raw.write,
      raw.fchmod,
      raw.fstat,
      raw.close,
      raw.unlink
    ]) {
      expect(operation).toHaveBeenCalledOnce()
      expect(vi.mocked(operation).mock.instances[0]).toBe(raw)
    }
  })

  it('awaits raw close after retained callbacks settle', async () => {
    const raw = createRawSession()
    let retainedCallback: Callback | undefined
    vi.mocked(raw.write).mockImplementationOnce(
      (_handle, _buffer, _offset, _length, _position, callback) => {
        retainedCallback = callback
      }
    )
    const { opened, forceCloseConnection } = openSession(raw)
    const session = await opened
    let writeSettled = false
    session.operations.write(Buffer.from('h'), Buffer.from('x'), 0, 1, 0, () => {
      writeSettled = true
    })
    let closeSettled = false
    const close = session.close().then(() => {
      closeSettled = true
    })

    await Promise.resolve()
    expect(raw.end).toHaveBeenCalledOnce()
    expect(closeSettled).toBe(false)
    retainedCallback?.(new Error('session closed'))
    raw.emit('close')
    await close
    expect(writeSettled).toBe(true)
    expect(forceCloseConnection).not.toHaveBeenCalled()
  })

  it('makes concurrent close idempotent', async () => {
    const raw = createRawSession()
    const { opened } = openSession(raw)
    const session = await opened

    const first = session.close()
    const second = session.close(new Error('later reason'))
    expect(first).toBe(second)
    raw.emit('close')
    await first
    expect(raw.end).toHaveBeenCalledOnce()
  })

  it('waits for close before rejecting a raw session error', async () => {
    const raw = createRawSession()
    const { opened } = openSession(raw)
    const session = await opened
    const close = session.close()

    raw.emit('error', new Error('raw session failed'))
    const early = await Promise.race([
      close.then(
        () => 'settled',
        () => 'settled'
      ),
      Promise.resolve('pending')
    ])
    expect(early).toBe('pending')
    raw.emit('close')
    await expect(close).rejects.toThrow('raw session failed')
  })

  it('forces the owning connection after the five-second close grace', async () => {
    vi.useFakeTimers()
    try {
      const raw = createRawSession()
      const forceCloseConnection = vi.fn(async () => {})
      const { opened } = openSession(raw, { forceCloseConnection })
      const session = await opened
      const reason = new Error('cancelled transfer')
      const close = session.close(reason)

      await vi.advanceTimersByTimeAsync(4_999)
      expect(forceCloseConnection).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(await Promise.race([close.then(() => 'settled'), Promise.resolve('pending')])).toBe(
        'pending'
      )
      raw.emit('close')
      await close
      expect(forceCloseConnection).toHaveBeenCalledWith(reason)
    } finally {
      vi.useRealTimers()
    }
  })

  it('force-closes and reports a synchronous raw end failure', async () => {
    const raw = createRawSession()
    vi.mocked(raw.end).mockImplementationOnce(() => {
      throw new Error('raw end failed')
    })
    const forceCloseConnection = vi.fn(async () => {
      raw.emit('close')
    })
    const { opened } = openSession(raw, { forceCloseConnection })
    const session = await opened

    await expect(session.close()).rejects.toThrow('raw end failed')
    expect(forceCloseConnection).toHaveBeenCalledOnce()
  })

  it('reports force-close failure and does not invent raw close', async () => {
    vi.useFakeTimers()
    try {
      const raw = createRawSession()
      const { opened } = openSession(raw, {
        forceCloseConnection: async () => {
          throw new Error('force close failed')
        }
      })
      const session = await opened
      const close = session.close(new Error('primary'))
      const rejected = expect(close).rejects.toThrow('force close failed')

      await vi.advanceTimersByTimeAsync(5_000)
      await rejected
    } finally {
      vi.useRealTimers()
    }
  })

  it('closes a raw session returned after cancellation and rejects opening', async () => {
    const raw = createRawSession()
    const controller = new AbortController()
    const { opened } = openSession(raw, { signal: controller.signal })
    controller.abort(new Error('cancelled after raw open'))

    await Promise.resolve()
    raw.emit('close')
    await expect(opened).rejects.toThrow('cancelled after raw open')
    expect(raw.end).toHaveBeenCalledOnce()
  })

  it('rejects late operations without invoking the raw session or exposing paths', async () => {
    const raw = createRawSession()
    const { opened } = openSession(raw)
    const session = await opened
    const close = session.close()
    raw.emit('close')
    await close
    const callback = vi.fn()
    const secret = '/home/private-user/stage/node'

    session.operations.unlink(secret, callback)
    expect(raw.unlink).not.toHaveBeenCalled()
    expect(callback).toHaveBeenCalledWith(expect.any(Error))
    expect(callback.mock.calls[0]?.[0]?.message).not.toContain(secret)
  })
})
