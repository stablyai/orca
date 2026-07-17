import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import type { ClientChannel } from 'ssh2'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  openSshRelayRuntimePosixFileDestination,
  SSH_RELAY_RUNTIME_POSIX_FILE_DESTINATION_LIMITS
} from './ssh-relay-runtime-posix-file-destination'
import {
  openSshRelayRuntimeSystemSshFileChannel as openSystemSshFileChannelWithDialect,
  SSH_RELAY_RUNTIME_SYSTEM_SSH_FILE_CHANNEL_LIMITS,
  type SshRelayRuntimeSystemSshConnection
} from './ssh-relay-runtime-system-ssh-file-channel'

type WriteCallback = (error?: Error) => void

type FakeChannel = EventEmitter & {
  stdin: EventEmitter & {
    write: ReturnType<typeof vi.fn<(chunk: Buffer, callback: WriteCallback) => boolean>>
    end: ReturnType<typeof vi.fn<() => void>>
  }
  stderr: EventEmitter
  resume: ReturnType<typeof vi.fn<() => FakeChannel>>
  close: ReturnType<typeof vi.fn<() => void>>
  _process?: ChildProcess
}

function createChannel(options: { process?: boolean } = {}): {
  channel: FakeChannel
  kill: ReturnType<typeof vi.fn<(signal?: NodeJS.Signals | number) => boolean>>
  process: { exitCode: number | null; signalCode: NodeJS.Signals | null }
} {
  const emitter = new EventEmitter() as FakeChannel
  const stdin = Object.assign(new EventEmitter(), {
    write: vi.fn((_chunk: Buffer, callback: WriteCallback) => {
      callback()
      return true
    }),
    end: vi.fn()
  })
  const kill = vi.fn(() => true)
  emitter.stdin = stdin
  emitter.stderr = new EventEmitter()
  emitter.resume = vi.fn(() => emitter)
  emitter.close = vi.fn()
  const process = { exitCode: null, signalCode: null, kill }
  if (options.process !== false) {
    emitter._process = process as unknown as ChildProcess
  }
  return { channel: emitter, kill, process }
}

function createConnection(
  channel: FakeChannel,
  systemTransport = true
): SshRelayRuntimeSystemSshConnection & {
  exec: ReturnType<typeof vi.fn<SshRelayRuntimeSystemSshConnection['exec']>>
} {
  return {
    usesSystemSshTransport: vi.fn(() => systemTransport),
    exec: vi.fn(async () => channel as unknown as ClientChannel)
  }
}

function openSshRelayRuntimeSystemSshFileChannel(
  connection: SshRelayRuntimeSystemSshConnection,
  command: string,
  signal: AbortSignal
) {
  return openSystemSshFileChannelWithDialect(connection, command, signal, 'posix')
}

afterEach(() => {
  vi.useRealTimers()
})

describe('SSH relay runtime system-SSH file channel', () => {
  it('rejects non-system transport and pre-abort before exec', async () => {
    const { channel } = createChannel()
    const nonSystem = createConnection(channel, false)

    await expect(
      openSshRelayRuntimeSystemSshFileChannel(
        nonSystem,
        'cat command',
        new AbortController().signal
      )
    ).rejects.toThrow(/system ssh/i)
    expect(nonSystem.exec).not.toHaveBeenCalled()

    const cancelled = createConnection(channel)
    const controller = new AbortController()
    const reason = new Error('cancelled before exec')
    controller.abort(reason)
    await expect(
      openSshRelayRuntimeSystemSshFileChannel(cancelled, 'cat command', controller.signal)
    ).rejects.toBe(reason)
    expect(cancelled.exec).not.toHaveBeenCalled()
  })

  it('opens once with the exact command and keeps cancellation single-owned', async () => {
    const { channel } = createChannel()
    const connection = createConnection(channel)
    const controller = new AbortController()
    const adapted = await openSshRelayRuntimeSystemSshFileChannel(
      connection,
      'exact remote command',
      controller.signal
    )

    expect(connection.exec).toHaveBeenCalledOnce()
    expect(connection.exec).toHaveBeenCalledWith('exact remote command')
    expect(channel.resume).toHaveBeenCalledOnce()
    channel.emit('close', 0, null)
    await expect(adapted.settled).resolves.toBeUndefined()
    expect(channel.listenerCount('error')).toBe(0)
    expect(channel.listenerCount('close')).toBe(0)
    expect(channel.stderr.listenerCount('data')).toBe(0)
    expect(channel.stderr.listenerCount('error')).toBe(0)
  })

  it('preserves POSIX wrapping and disables it only for complete PowerShell commands', async () => {
    const posix = createChannel()
    const posixConnection = createConnection(posix.channel)
    const posixAdapted = await openSystemSshFileChannelWithDialect(
      posixConnection,
      'cat command',
      new AbortController().signal,
      'posix'
    )

    expect(posixConnection.exec).toHaveBeenCalledWith('cat command')
    posix.channel.emit('close', 0, null)
    await expect(posixAdapted.settled).resolves.toBeUndefined()

    const powershell = createChannel()
    const powershellConnection = createConnection(powershell.channel)
    const powershellAdapted = await openSystemSshFileChannelWithDialect(
      powershellConnection,
      'powershell.exe -EncodedCommand AAAA',
      new AbortController().signal,
      'powershell'
    )

    expect(powershellConnection.exec).toHaveBeenCalledWith('powershell.exe -EncodedCommand AAAA', {
      wrapCommand: false
    })
    powershell.channel.emit('close', 0, null)
    await expect(powershellAdapted.settled).resolves.toBeUndefined()
  })

  it('forwards the exact borrowed chunk callback and EOF to child stdin', async () => {
    const { channel } = createChannel()
    let retainedCallback: WriteCallback | undefined
    channel.stdin.write.mockImplementationOnce((_chunk, callback) => {
      retainedCallback = callback
      return false
    })
    const adapted = await openSshRelayRuntimeSystemSshFileChannel(
      createConnection(channel),
      'cat command',
      new AbortController().signal
    )
    const chunk = Buffer.alloc(64 * 1024, 3)
    const callback = vi.fn()

    adapted.write(chunk, callback)
    expect(channel.stdin.write).toHaveBeenCalledWith(chunk, callback)
    expect(callback).not.toHaveBeenCalled()
    retainedCallback?.()
    expect(callback).toHaveBeenCalledOnce()
    adapted.end()
    expect(channel.stdin.end).toHaveBeenCalledOnce()
    channel.emit('close', 0, null)
    await adapted.settled
  })

  it.each([
    [1, null, 'exit 1'],
    [null, 'SIGTERM', 'signal SIGTERM']
  ] as const)('rejects nonzero settlement %j/%j', async (code, signal, expected) => {
    const { channel } = createChannel()
    const adapted = await openSshRelayRuntimeSystemSshFileChannel(
      createConnection(channel),
      'cat command',
      new AbortController().signal
    )

    channel.stderr.emit('data', Buffer.from('remote cat failed'))
    channel.emit('close', code, signal)
    await expect(adapted.settled).rejects.toThrow(expected)
    await expect(adapted.settled).rejects.toThrow('remote cat failed')
  })

  it.each(['channel', 'stderr'] as const)(
    'propagates %s errors and removes listeners',
    async (from) => {
      const { channel } = createChannel()
      const adapted = await openSshRelayRuntimeSystemSshFileChannel(
        createConnection(channel),
        'cat command',
        new AbortController().signal
      )
      const error = new Error(`${from} failed`)

      if (from === 'channel') {
        channel.emit('error', error)
      } else {
        channel.stderr.emit('error', error)
      }
      await expect(adapted.settled).rejects.toBe(error)
      expect(channel.listenerCount('error')).toBe(0)
      expect(channel.listenerCount('close')).toBe(0)
      expect(channel.stderr.listenerCount('data')).toBe(0)
      expect(channel.stderr.listenerCount('error')).toBe(0)
    }
  )

  it('copies and caps attacker-sized stderr with an explicit marker', async () => {
    const { channel } = createChannel()
    const adapted = await openSshRelayRuntimeSystemSshFileChannel(
      createConnection(channel),
      'cat command',
      new AbortController().signal
    )
    const diagnostic = Buffer.alloc(
      SSH_RELAY_RUNTIME_SYSTEM_SSH_FILE_CHANNEL_LIMITS.diagnosticBytes * 4,
      's'
    )

    channel.stderr.emit('data', diagnostic)
    diagnostic.fill('x')
    channel.emit('close', 9, null)
    const error = await adapted.settled.catch((reason: Error) => reason)
    expect(error).toBeInstanceOf(Error)
    if (!(error instanceof Error)) {
      throw new Error('expected system SSH settlement failure')
    }
    expect(error.message).toContain('sss')
    expect(error.message).not.toContain('xxx')
    expect(error.message).toContain('truncated')
    expect(Buffer.byteLength(error.message)).toBeLessThanOrEqual(
      SSH_RELAY_RUNTIME_SYSTEM_SSH_FILE_CHANNEL_LIMITS.diagnosticBytes + 200
    )
  })

  it('makes graceful and forced close idempotent and ordered', async () => {
    const { channel, kill } = createChannel()
    const adapted = await openSshRelayRuntimeSystemSshFileChannel(
      createConnection(channel),
      'cat command',
      new AbortController().signal
    )
    void adapted.settled.catch(() => {})

    adapted.requestClose()
    adapted.requestClose()
    adapted.forceClose()
    adapted.forceClose()
    expect(channel.close).toHaveBeenCalledOnce()
    expect(kill).toHaveBeenCalledOnce()
    expect(kill).toHaveBeenCalledWith('SIGKILL')
    expect(channel.close.mock.invocationCallOrder[0]).toBeLessThan(kill.mock.invocationCallOrder[0])
  })

  it('does not force an exited child and fails closed without process ownership or signaling', async () => {
    const exited = createChannel()
    exited.process.exitCode = 0
    const exitedAdapter = await openSshRelayRuntimeSystemSshFileChannel(
      createConnection(exited.channel),
      'cat command',
      new AbortController().signal
    )
    void exitedAdapter.settled.catch(() => {})
    exitedAdapter.forceClose()
    expect(exited.kill).not.toHaveBeenCalled()

    const missing = createChannel({ process: false })
    const missingAdapter = await openSshRelayRuntimeSystemSshFileChannel(
      createConnection(missing.channel),
      'cat command',
      new AbortController().signal
    )
    void missingAdapter.settled.catch(() => {})
    expect(() => missingAdapter.forceClose()).toThrow(/process ownership/i)

    const unsignaled = createChannel()
    unsignaled.kill.mockReturnValue(false)
    const unsignaledAdapter = await openSshRelayRuntimeSystemSshFileChannel(
      createConnection(unsignaled.channel),
      'cat command',
      new AbortController().signal
    )
    void unsignaledAdapter.settled.catch(() => {})
    expect(() => unsignaledAdapter.forceClose()).toThrow(/forced termination/i)
  })

  it('propagates thrown graceful and forced termination failures once', async () => {
    const { channel, kill } = createChannel()
    channel.close.mockImplementation(() => {
      throw new Error('SIGTERM failed')
    })
    kill.mockImplementation(() => {
      throw new Error('SIGKILL failed')
    })
    const adapted = await openSshRelayRuntimeSystemSshFileChannel(
      createConnection(channel),
      'cat command',
      new AbortController().signal
    )
    void adapted.settled.catch(() => {})

    expect(() => adapted.requestClose()).toThrow('SIGTERM failed')
    expect(() => adapted.requestClose()).not.toThrow()
    expect(() => adapted.forceClose()).toThrow('SIGKILL failed')
    expect(() => adapted.forceClose()).not.toThrow()
  })

  it('composes retained-write cancellation through graceful process settlement', async () => {
    const { channel, kill } = createChannel()
    channel.stdin.write.mockImplementation(() => true)
    channel.close.mockImplementation(() => channel.emit('close', null, 'SIGTERM'))
    const connection = createConnection(channel)
    const controller = new AbortController()
    const reason = new Error('cancelled retained system SSH write')
    const destination = await openSshRelayRuntimePosixFileDestination({
      remotePath: '/owned-stage/bin/node',
      mode: 0o755,
      signal: controller.signal,
      openChannel: (command, signal) =>
        openSshRelayRuntimeSystemSshFileChannel(connection, command, signal)
    })
    const writing = destination.write(Buffer.alloc(64 * 1024, 5))

    controller.abort(reason)
    await expect(writing).rejects.toBe(reason)
    await expect(destination.abort(reason)).resolves.toBeUndefined()
    expect(channel.close).toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
  })

  it('composes forced settlement without adding a second timer', async () => {
    vi.useFakeTimers()
    const { channel, kill } = createChannel()
    kill.mockImplementation(() => {
      channel.emit('close', null, 'SIGKILL')
      return true
    })
    const controller = new AbortController()
    const destination = await openSshRelayRuntimePosixFileDestination({
      remotePath: '/owned-stage/bin/node',
      mode: 0o755,
      signal: controller.signal,
      openChannel: (command, signal) =>
        openSshRelayRuntimeSystemSshFileChannel(createConnection(channel), command, signal)
    })

    controller.abort(new Error('cancelled'))
    const aborting = destination.abort(controller.signal.reason)
    await vi.advanceTimersByTimeAsync(
      SSH_RELAY_RUNTIME_POSIX_FILE_DESTINATION_LIMITS.gracefulCloseMs
    )
    await expect(aborting).resolves.toBeUndefined()
    expect(channel.close).toHaveBeenCalledOnce()
    expect(kill).toHaveBeenCalledWith('SIGKILL')
  })
})
