import { EventEmitter } from 'node:events'

import type { Client, SFTPWrapper } from 'ssh2'
import { describe, expect, it, vi } from 'vitest'

import type { SshConnection } from './ssh-connection'
import { openSshRelayRuntimeSftpTreeSessionForConnection } from './ssh-relay-runtime-sftp-connection-transfer'

type Callback = (error?: Error) => void
type ConnectionBoundary = Pick<SshConnection, 'getClient' | 'sftp' | 'usesSystemSshTransport'>

function createRawSession(options: { closeOnEnd?: boolean } = {}): SFTPWrapper {
  const emitter = new EventEmitter()
  const raw = Object.assign(emitter, {
    mkdir: vi.fn((_path: string, _attributes: unknown, callback: Callback) => callback()),
    rmdir: vi.fn((_path: string, callback: Callback) => callback()),
    open: vi.fn(
      (
        _path: string,
        _flags: string,
        _attributes: unknown,
        callback: (error: Error | undefined, handle: Buffer) => void
      ) => callback(undefined, Buffer.from('handle'))
    ),
    write: vi.fn(
      (
        _handle: Buffer,
        _buffer: Buffer,
        _offset: number,
        _length: number,
        _position: number,
        callback: Callback
      ) => callback()
    ),
    fchmod: vi.fn((_handle: Buffer, _mode: number, callback: Callback) => callback()),
    fstat: vi.fn(
      (_handle: Buffer, callback: (error: Error | undefined, value: { mode: number }) => void) =>
        callback(undefined, { mode: 0o100755 })
    ),
    close: vi.fn((_handle: Buffer, callback: Callback) => callback()),
    unlink: vi.fn((_path: string, callback: Callback) => callback()),
    end: vi.fn(() => {
      if (options.closeOnEnd) {
        queueMicrotask(() => emitter.emit('close'))
      }
    })
  })
  return raw as unknown as SFTPWrapper
}

function createClient(onDestroy?: () => void): Client & { destroy: ReturnType<typeof vi.fn> } {
  const emitter = new EventEmitter()
  const client = Object.assign(emitter, {
    destroy: vi.fn(() => onDestroy?.())
  })
  return client as unknown as Client & { destroy: ReturnType<typeof vi.fn> }
}

function createConnection(
  client: Client | null,
  raw: SFTPWrapper,
  options: { systemSsh?: boolean; onSftp?: () => void } = {}
): ConnectionBoundary & {
  setClient: (next: Client | null) => void
  sftp: ReturnType<typeof vi.fn>
} {
  let currentClient = client
  const sftp = vi.fn(async (_signal?: AbortSignal) => {
    options.onSftp?.()
    return raw
  })
  return {
    getClient: () => currentClient,
    setClient: (next) => {
      currentClient = next
    },
    usesSystemSshTransport: () => options.systemSsh ?? false,
    sftp
  }
}

describe('SSH relay runtime authenticated SFTP connection transfer', () => {
  it('opens one raw session with the exact signal and leaves the connection open after normal close', async () => {
    const raw = createRawSession({ closeOnEnd: true })
    const client = createClient()
    const connection = createConnection(client, raw)
    const signal = new AbortController().signal

    const session = await openSshRelayRuntimeSftpTreeSessionForConnection(connection, signal)
    await session.close()

    expect(connection.sftp).toHaveBeenCalledOnce()
    expect(connection.sftp).toHaveBeenCalledWith(signal)
    expect(raw.end).toHaveBeenCalledOnce()
    expect(client.destroy).not.toHaveBeenCalled()
  })

  it('rejects system SSH without opening an SFTP channel', async () => {
    const raw = createRawSession()
    const connection = createConnection(null, raw, { systemSsh: true })

    await expect(
      openSshRelayRuntimeSftpTreeSessionForConnection(connection, new AbortController().signal)
    ).rejects.toThrow(/built-in SSH/i)
    expect(connection.sftp).not.toHaveBeenCalled()
  })

  it('closes a raw channel opened by a replaced connection generation', async () => {
    const raw = createRawSession({ closeOnEnd: true })
    const first = createClient()
    const replacement = createClient()
    const connection = createConnection(first, raw, {
      onSftp: () => connection.setClient(replacement)
    })

    await expect(
      openSshRelayRuntimeSftpTreeSessionForConnection(connection, new AbortController().signal)
    ).rejects.toThrow(/connection changed/i)
    expect(raw.end).toHaveBeenCalledOnce()
    expect(first.destroy).not.toHaveBeenCalled()
    expect(replacement.destroy).not.toHaveBeenCalled()
  })

  it('force-closes only the captured client and awaits both client and raw close', async () => {
    vi.useFakeTimers()
    try {
      const raw = createRawSession()
      const first = createClient(() => {
        raw.emit('close')
        first.emit('close')
      })
      const replacement = createClient()
      const connection = createConnection(first, raw)
      const session = await openSshRelayRuntimeSftpTreeSessionForConnection(
        connection,
        new AbortController().signal
      )
      connection.setClient(replacement)
      const close = session.close(new Error('cancelled transfer'))

      await vi.advanceTimersByTimeAsync(5_000)
      await close
      expect(first.destroy).toHaveBeenCalledOnce()
      expect(replacement.destroy).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails within the bounded force-close window when client teardown never confirms', async () => {
    vi.useFakeTimers()
    try {
      const raw = createRawSession()
      const client = createClient()
      const connection = createConnection(client, raw)
      const session = await openSshRelayRuntimeSftpTreeSessionForConnection(
        connection,
        new AbortController().signal
      )
      const close = session.close()
      const rejected = expect(close).rejects.toThrow(/connection close timed out/i)

      await vi.advanceTimersByTimeAsync(10_000)
      await rejected
      expect(client.destroy).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
})
