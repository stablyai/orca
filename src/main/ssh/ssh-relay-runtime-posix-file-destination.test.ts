import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  openSshRelayRuntimePosixFileDestination,
  SSH_RELAY_RUNTIME_POSIX_FILE_DESTINATION_LIMITS,
  type SshRelayRuntimePosixFileChannel
} from './ssh-relay-runtime-posix-file-destination'

type Callback = (error?: Error) => void

function createChannel(): {
  channel: SshRelayRuntimePosixFileChannel
  resolve: () => void
  reject: (error: Error) => void
} {
  let resolveSettled: () => void = () => {}
  let rejectSettled: (error: Error) => void = () => {}
  const settled = new Promise<void>((resolve, reject) => {
    resolveSettled = resolve
    rejectSettled = reject
  })
  const channel: SshRelayRuntimePosixFileChannel = {
    write: vi.fn((_chunk: Buffer, callback: Callback) => callback()),
    end: vi.fn(),
    settled,
    requestClose: vi.fn(),
    forceClose: vi.fn()
  }
  return { channel, resolve: resolveSettled, reject: rejectSettled }
}

function openDestination(
  channel: SshRelayRuntimePosixFileChannel,
  options: {
    remotePath?: string
    mode?: number
    signal?: AbortSignal
    openChannel?: (command: string, signal: AbortSignal) => Promise<SshRelayRuntimePosixFileChannel>
  } = {}
) {
  return openSshRelayRuntimePosixFileDestination({
    remotePath: options.remotePath ?? "/owned stage/bin/no'de",
    mode: (options.mode ?? 0o755) as 0o644 | 0o755,
    signal: options.signal ?? new AbortController().signal,
    openChannel: options.openChannel ?? vi.fn(async () => channel)
  })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('SSH relay runtime POSIX no-tar file destination', () => {
  it('builds one exclusive restrictive command with exact quoting and final mode order', async () => {
    const { channel, resolve } = createChannel()
    const controller = new AbortController()
    const openChannel = vi.fn(async (_command: string, _signal: AbortSignal) => channel)
    const destination = await openDestination(channel, {
      signal: controller.signal,
      openChannel
    })

    expect(openChannel).toHaveBeenCalledWith(
      "umask 077; set -C; cat > '/owned stage/bin/no'\\''de' && chmod 0755 '/owned stage/bin/no'\\''de'",
      controller.signal
    )
    const command = openChannel.mock.calls[0]?.[0] ?? ''
    for (const forbidden of ['node ', 'python', 'perl', 'tar ', 'base64', 'sha256sum', 'shasum']) {
      expect(command.toLowerCase()).not.toContain(forbidden)
    }

    const closing = destination.close()
    expect(channel.end).toHaveBeenCalledOnce()
    resolve()
    await closing
  })

  it('authenticates a non-executable final mode in the same command', async () => {
    const { channel, resolve } = createChannel()
    const openChannel = vi.fn(async (_command: string, _signal: AbortSignal) => channel)
    const destination = await openDestination(channel, {
      remotePath: '/owned-stage/目录/manifest.json',
      mode: 0o644,
      openChannel
    })

    expect(openChannel.mock.calls[0]?.[0]).toBe(
      "umask 077; set -C; cat > '/owned-stage/目录/manifest.json' && chmod 0644 '/owned-stage/目录/manifest.json'"
    )
    const closing = destination.close()
    resolve()
    await closing
  })

  it.each([
    ['', 0o755],
    ['relative/file', 0o755],
    ['/', 0o755],
    ['/owned//file', 0o755],
    ['/owned/../file', 0o755],
    ['/owned/./file', 0o755],
    ['/owned/file/', 0o755],
    ['/owned/file\nnext', 0o755],
    ['/owned/file\0next', 0o755],
    ['/owned/file', 0o600]
  ])('rejects hostile path %j or mode %d before opening a channel', async (remotePath, mode) => {
    const { channel } = createChannel()
    const openChannel = vi.fn(async () => channel)

    await expect(openDestination(channel, { remotePath, mode, openChannel })).rejects.toThrow(
      /invalid/i
    )
    expect(openChannel).not.toHaveBeenCalled()
  })

  it('sends EOF once for a zero-byte file and awaits remote settlement', async () => {
    const { channel, resolve } = createChannel()
    const destination = await openDestination(channel)
    let settled = false
    const closing = destination.close().then(() => {
      settled = true
    })

    await Promise.resolve()
    expect(channel.end).toHaveBeenCalledOnce()
    expect(settled).toBe(false)
    resolve()
    await closing
    await expect(destination.close()).rejects.toThrow(/closed/i)
    expect(channel.end).toHaveBeenCalledOnce()
  })

  it('awaits exact chunk callbacks and rejects concurrent operations', async () => {
    const { channel, resolve } = createChannel()
    let firstCallback: Callback | undefined
    vi.mocked(channel.write).mockImplementationOnce((_chunk, callback) => {
      firstCallback = callback
    })
    const destination = await openDestination(channel)
    const first = Buffer.from('first')
    let settled = false
    const writing = destination.write(first).then(() => {
      settled = true
    })

    await Promise.resolve()
    expect(channel.write).toHaveBeenCalledWith(first, expect.any(Function))
    expect(settled).toBe(false)
    await expect(destination.write(Buffer.from('second'))).rejects.toThrow(/concurrent/i)
    await expect(destination.close()).rejects.toThrow(/concurrent/i)
    firstCallback?.()
    await writing
    await destination.write(Buffer.from('second'))
    const closing = destination.close()
    resolve()
    await closing
  })

  it('rejects empty chunks and propagates channel write failures', async () => {
    const { channel, resolve } = createChannel()
    vi.mocked(channel.write).mockImplementationOnce((_chunk, callback) => {
      callback(new Error('channel write failed'))
    })
    const destination = await openDestination(channel)

    await expect(destination.write(Buffer.alloc(0))).rejects.toThrow(/empty/i)
    await expect(destination.write(Buffer.from('payload'))).rejects.toThrow('channel write failed')
    const closing = destination.close()
    resolve()
    await closing
  })

  it('propagates remote nonzero settlement on close', async () => {
    const { channel, reject } = createChannel()
    const destination = await openDestination(channel)
    const closing = destination.close()
    reject(new Error('remote cat failed (exit 1)'))

    await expect(closing).rejects.toThrow('remote cat failed')
  })

  it('rejects pre-open cancellation without opening a channel', async () => {
    const { channel } = createChannel()
    const controller = new AbortController()
    const reason = new Error('cancelled before open')
    controller.abort(reason)
    const openChannel = vi.fn(async () => channel)

    await expect(openDestination(channel, { signal: controller.signal, openChannel })).rejects.toBe(
      reason
    )
    expect(openChannel).not.toHaveBeenCalled()
  })

  it('settles a channel returned after mid-open cancellation', async () => {
    const { channel, resolve } = createChannel()
    const controller = new AbortController()
    const reason = new Error('cancelled during open')
    vi.mocked(channel.requestClose).mockImplementation(() => resolve())
    const openChannel = vi.fn(async () => {
      controller.abort(reason)
      return channel
    })

    await expect(openDestination(channel, { signal: controller.signal, openChannel })).rejects.toBe(
      reason
    )
    expect(channel.requestClose).toHaveBeenCalledOnce()
    expect(channel.forceClose).not.toHaveBeenCalled()
  })

  it('holds a retained write buffer until cancellation settles the channel', async () => {
    const { channel, resolve } = createChannel()
    const controller = new AbortController()
    const reason = new Error('cancelled during write')
    vi.mocked(channel.write).mockImplementation(() => {})
    vi.mocked(channel.requestClose).mockImplementation(() => resolve())
    const destination = await openDestination(channel, { signal: controller.signal })
    const chunk = Buffer.alloc(64 * 1024, 7)
    let settled = false
    const writing = destination.write(chunk).finally(() => {
      settled = true
    })

    controller.abort(reason)
    await Promise.resolve()
    expect(channel.requestClose).toHaveBeenCalledOnce()
    await expect(writing).rejects.toBe(reason)
    expect(settled).toBe(true)
    await expect(destination.abort(reason)).resolves.toBeUndefined()
    await expect(destination.write(Buffer.from('later'))).rejects.toThrow(/closed/i)
    expect(channel.write).toHaveBeenCalledOnce()
  })

  it('cancels a close only after the command channel settles', async () => {
    const { channel, resolve } = createChannel()
    const controller = new AbortController()
    const reason = new Error('cancelled during close')
    vi.mocked(channel.requestClose).mockImplementation(() => resolve())
    const destination = await openDestination(channel, { signal: controller.signal })
    const closing = destination.close()

    controller.abort(reason)
    await expect(destination.abort(reason)).resolves.toBeUndefined()
    await expect(closing).rejects.toBe(reason)
    expect(channel.end).toHaveBeenCalledOnce()
    expect(channel.requestClose).toHaveBeenCalledOnce()
  })

  it('settles ordinary cancellation during the graceful window', async () => {
    const { channel, resolve } = createChannel()
    const controller = new AbortController()
    vi.mocked(channel.requestClose).mockImplementation(() => resolve())
    const destination = await openDestination(channel, { signal: controller.signal })

    controller.abort(new Error('cancelled'))
    await expect(destination.abort(controller.signal.reason)).resolves.toBeUndefined()
    expect(channel.requestClose).toHaveBeenCalledOnce()
    expect(channel.forceClose).not.toHaveBeenCalled()
  })

  it('forces a channel that does not settle during the graceful window', async () => {
    vi.useFakeTimers()
    const { channel, resolve } = createChannel()
    const controller = new AbortController()
    vi.mocked(channel.forceClose).mockImplementation(() => resolve())
    const destination = await openDestination(channel, { signal: controller.signal })

    controller.abort(new Error('cancelled'))
    const aborting = destination.abort(controller.signal.reason)
    await vi.advanceTimersByTimeAsync(
      SSH_RELAY_RUNTIME_POSIX_FILE_DESTINATION_LIMITS.gracefulCloseMs
    )
    await expect(aborting).resolves.toBeUndefined()
    expect(channel.requestClose).toHaveBeenCalledOnce()
    expect(channel.forceClose).toHaveBeenCalledOnce()
  })

  it('fails closed when forced channel settlement reaches the total ceiling', async () => {
    vi.useFakeTimers()
    const { channel } = createChannel()
    const controller = new AbortController()
    const destination = await openDestination(channel, { signal: controller.signal })

    controller.abort(new Error('cancelled'))
    const aborting = destination.abort(controller.signal.reason)
    await vi.advanceTimersByTimeAsync(SSH_RELAY_RUNTIME_POSIX_FILE_DESTINATION_LIMITS.totalCloseMs)

    await expect(aborting).rejects.toThrow(/settlement timed out/i)
    expect(channel.requestClose).toHaveBeenCalledOnce()
    expect(channel.forceClose).toHaveBeenCalledOnce()
  })

  it('propagates cleanup request failures after the channel settles', async () => {
    const { channel, resolve } = createChannel()
    const controller = new AbortController()
    vi.mocked(channel.requestClose).mockImplementation(() => {
      resolve()
      throw new Error('graceful close failed')
    })
    const destination = await openDestination(channel, { signal: controller.signal })

    controller.abort(new Error('cancelled'))
    await expect(destination.abort(controller.signal.reason)).rejects.toThrow(
      'graceful close failed'
    )
  })

  it('makes abort idempotent and never sends EOF after cancellation', async () => {
    const { channel, resolve } = createChannel()
    const controller = new AbortController()
    vi.mocked(channel.requestClose).mockImplementation(() => resolve())
    const destination = await openDestination(channel, { signal: controller.signal })
    const reason = new Error('cancelled')

    controller.abort(reason)
    const first = destination.abort(reason)
    const second = destination.abort(reason)
    expect(first).toBe(second)
    await first
    expect(channel.requestClose).toHaveBeenCalledOnce()
    expect(channel.end).not.toHaveBeenCalled()
    await expect(destination.close()).rejects.toThrow(/closed/i)
  })
})
