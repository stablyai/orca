import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { ClientChannel } from 'ssh2'
import { execCommand, waitForSentinel } from './ssh-relay-deploy-helpers'
import { shouldProbeBuildToolchainAfterNativeDepsFailure } from './ssh-relay-build-toolchain'
import { RELAY_SENTINEL } from './relay-protocol'
import {
  RelayVersionMismatchError,
  RELAY_EXIT_CODE_VERSION_MISMATCH
} from './ssh-relay-version-mismatch-error'

function createMockChannel(): ClientChannel {
  return Object.assign(new EventEmitter(), {
    stderr: new EventEmitter(),
    stdin: { write: vi.fn() },
    close: vi.fn()
  }) as unknown as ClientChannel
}

// execCommand only rejects with Error; narrow the caught reason (its resolve
// type is string) and fail loudly if the command unexpectedly succeeds.
async function execCommandRejection(promise: Promise<string>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error('expected execCommand to reject')
    },
    (err: Error) => err
  )
}

describe('waitForSentinel', () => {
  it('buffers post-sentinel chunks until the transport subscribes', async () => {
    const channel = createMockChannel()
    const transportPromise = waitForSentinel(channel)

    channel.emit('data', Buffer.from(RELAY_SENTINEL))
    channel.emit('data', Buffer.from('first-frame-after-sentinel'))

    const transport = await transportPromise
    const chunks: string[] = []
    transport.onData((chunk) => chunks.push(chunk.toString('utf-8')))

    expect(chunks).toEqual(['first-frame-after-sentinel'])
  })

  it('buffers post-sentinel bytes from the sentinel chunk', async () => {
    const channel = createMockChannel()
    const transportPromise = waitForSentinel(channel)

    channel.emit('data', Buffer.from(`${RELAY_SENTINEL}same-chunk-frame`))

    const transport = await transportPromise
    const chunks: string[] = []
    transport.onData((chunk) => chunks.push(chunk.toString('utf-8')))

    expect(chunks).toEqual(['same-chunk-frame'])
  })

  it('rejects on relay channel errors before the sentinel instead of emitting uncaught errors', async () => {
    const channel = createMockChannel()
    const transportPromise = waitForSentinel(channel)

    expect(() => channel.emit('error', new Error('remote host rebooted'))).not.toThrow()
    await expect(transportPromise).rejects.toThrow('remote host rebooted')
  })

  it('notifies transport close subscribers on relay channel errors after the sentinel', async () => {
    const channel = createMockChannel()
    const transportPromise = waitForSentinel(channel)

    channel.emit('data', Buffer.from(RELAY_SENTINEL))
    const transport = await transportPromise
    const onClose = vi.fn()
    transport.onClose(onClose)

    expect(() => channel.emit('error', new Error('remote host rebooted'))).not.toThrow()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('translates a pre-sentinel exit-42 + close into RelayVersionMismatchError', async () => {
    const channel = createMockChannel()
    const transportPromise = waitForSentinel(channel)

    channel.stderr.emit(
      'data',
      Buffer.from(
        '[relay-connect] Handshake mismatch: expected=0.1.0+aaa, daemon=0.1.0+bbb; exiting 42\n'
      )
    )
    channel.emit('exit', RELAY_EXIT_CODE_VERSION_MISMATCH)
    channel.emit('close')

    await expect(transportPromise).rejects.toBeInstanceOf(RelayVersionMismatchError)
    await transportPromise.catch((err: RelayVersionMismatchError) => {
      expect(err.expected).toBe('0.1.0+aaa')
      expect(err.got).toBe('0.1.0+bbb')
    })
  })

  it('translates a pre-sentinel exit-42 even when the version detail is missing', async () => {
    const channel = createMockChannel()
    const transportPromise = waitForSentinel(channel)

    channel.stderr.emit('data', Buffer.from('boom\n'))
    channel.emit('exit', RELAY_EXIT_CODE_VERSION_MISMATCH)
    channel.emit('close')

    await expect(transportPromise).rejects.toBeInstanceOf(RelayVersionMismatchError)
  })

  it('rejects with a generic error (not RelayVersionMismatchError) on a non-42 exit code', async () => {
    const channel = createMockChannel()
    const transportPromise = waitForSentinel(channel)

    channel.stderr.emit('data', Buffer.from('node: bad bytecode\n'))
    channel.emit('exit', 1)
    channel.emit('close')

    await expect(transportPromise).rejects.toThrow(/Relay process exited before ready/)
    await transportPromise.catch((err: unknown) => {
      expect(err).not.toBeInstanceOf(RelayVersionMismatchError)
    })
  })

  it('rejects and closes the channel when pre-sentinel stdout exceeds the startup buffer cap', async () => {
    const channel = createMockChannel()
    const transportPromise = waitForSentinel(channel)

    channel.emit('data', Buffer.alloc(65 * 1024, 'a'))

    const outcome = await Promise.race([
      transportPromise.then(
        () => 'resolved',
        (err: Error) => `rejected:${err.message}`
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 0))
    ])
    if (outcome === 'pending') {
      channel.emit('close')
      await transportPromise.catch(() => {})
    }

    expect(outcome).toContain('Relay startup output exceeded')
    expect(channel.close).toHaveBeenCalledTimes(1)
  })

  it('does not count same-chunk post-sentinel payload against the startup buffer cap', async () => {
    const channel = createMockChannel()
    const transportPromise = waitForSentinel(channel)
    const postSentinelPayload = Buffer.alloc(70 * 1024, 'b')

    channel.emit(
      'data',
      Buffer.concat([
        Buffer.alloc(64 * 1024, 'a'),
        Buffer.from(RELAY_SENTINEL),
        postSentinelPayload
      ])
    )

    const transport = await transportPromise
    const chunks: Buffer[] = []
    transport.onData((chunk) => chunks.push(chunk))

    expect(Buffer.concat(chunks)).toEqual(postSentinelPayload)
    expect(channel.close).not.toHaveBeenCalled()
  })
})

describe('execCommand', () => {
  it('rejects on command channel errors instead of emitting uncaught errors', async () => {
    const channel = createMockChannel()
    const conn = {
      exec: vi.fn().mockResolvedValue(channel)
    }
    const commandPromise = execCommand(conn as never, 'uname -sm')

    await Promise.resolve()
    expect(() => channel.emit('error', new Error('remote host rebooted'))).not.toThrow()
    await expect(commandPromise).rejects.toThrow('remote host rebooted')
    expect(channel.listenerCount('error')).toBe(0)
    expect(channel.listenerCount('data')).toBe(0)
    expect(channel.listenerCount('close')).toBe(0)
    expect(channel.stderr.listenerCount('error')).toBe(0)
    expect(channel.stderr.listenerCount('data')).toBe(0)
  })

  it('includes stdout in nonzero-exit errors when stderr is empty', async () => {
    const channel = createMockChannel()
    const conn = {
      exec: vi.fn().mockResolvedValue(channel)
    }
    const commandPromise = execCommand(conn as never, 'npm install node-pty 2>&1')

    await Promise.resolve()
    channel.emit('data', Buffer.from('gyp ERR! stack Error: not found: make\n'))
    channel.emit('close', 1)

    await expect(commandPromise).rejects.toThrow('gyp ERR! stack Error: not found: make')
    expect(channel.listenerCount('error')).toBe(0)
    expect(channel.listenerCount('data')).toBe(0)
    expect(channel.listenerCount('close')).toBe(0)
    expect(channel.stderr.listenerCount('error')).toBe(0)
    expect(channel.stderr.listenerCount('data')).toBe(0)
  })

  it('surfaces stdout alongside stderr on nonzero exit instead of masking it', async () => {
    const channel = createMockChannel()
    const conn = {
      exec: vi.fn().mockResolvedValue(channel)
    }
    const commandPromise = execCommand(conn as never, 'npm install 2>&1')

    await Promise.resolve()
    // Why: the system-ssh transport routes the local OpenSSH client's own
    // diagnostics to channel.stderr while the remote command's merged output
    // arrives on stdout. stderr must not mask the real failure.
    channel.stderr.emit('data', Buffer.from("Warning: Permanently added 'host' (ED25519)\n"))
    channel.emit('data', Buffer.from("npm error g++: unrecognized '-std=gnu++20'\n"))
    channel.emit('close', 1)

    const error = await execCommandRejection(commandPromise)
    expect(error.message).toContain('Permanently added')
    expect(error.message).toContain('gnu++20')
  })

  it('keeps the merged error message greppable by the build-toolchain probe', async () => {
    const channel = createMockChannel()
    const conn = {
      exec: vi.fn().mockResolvedValue(channel)
    }
    const commandPromise = execCommand(conn as never, 'npm install 2>&1')

    await Promise.resolve()
    // Why: the OpenSSH banner alone never matches the probe, so the old
    // `stderr || stdout` masking suppressed the actionable "install build
    // tools" hint. The merged message keeps the node-gyp failure visible.
    channel.stderr.emit('data', Buffer.from("Warning: Permanently added 'host' (ED25519)\n"))
    channel.emit(
      'data',
      Buffer.from(
        'npm error gyp ERR! configure error\nnpm error gyp ERR! stack Error: not found: make\n'
      )
    )
    channel.emit('close', 1)

    const error = await execCommandRejection(commandPromise)
    expect(shouldProbeBuildToolchainAfterNativeDepsFailure(error.message)).toBe(true)
  })

  it('cleans command channel listeners when a command times out', async () => {
    vi.useFakeTimers()
    try {
      const channel = createMockChannel()
      const conn = {
        exec: vi.fn().mockResolvedValue(channel)
      }
      const commandPromise = execCommand(conn as never, 'sleep 60')

      await Promise.resolve()
      const rejection = expect(commandPromise).rejects.toThrow('timed out')
      await vi.advanceTimersByTimeAsync(30_000)

      await rejection
      expect(channel.close).toHaveBeenCalledOnce()
      expect(channel.listenerCount('error')).toBe(0)
      expect(channel.listenerCount('data')).toBe(0)
      expect(channel.listenerCount('close')).toBe(0)
      expect(channel.stderr.listenerCount('error')).toBe(0)
      expect(channel.stderr.listenerCount('data')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('closes and rejects with AbortError when a command is aborted', async () => {
    const channel = createMockChannel()
    const controller = new AbortController()
    const conn = {
      exec: vi.fn().mockResolvedValue(channel)
    }
    const commandPromise = execCommand(conn as never, 'sleep 60', {
      signal: controller.signal
    })

    await Promise.resolve()
    controller.abort()

    await expect(commandPromise).rejects.toMatchObject({ name: 'AbortError' })
    expect(channel.close).toHaveBeenCalledOnce()
    expect(channel.listenerCount('error')).toBe(0)
    expect(channel.listenerCount('data')).toBe(0)
    expect(channel.listenerCount('close')).toBe(0)
    expect(channel.stderr.listenerCount('error')).toBe(0)
    expect(channel.stderr.listenerCount('data')).toBe(0)
  })

  it('handles aborts that happen while the SSH exec channel is still opening', async () => {
    const channel = createMockChannel()
    const controller = new AbortController()
    let resolveExec: (channel: ClientChannel) => void = () => {}
    const conn = {
      exec: vi.fn().mockReturnValue(
        new Promise<ClientChannel>((resolve) => {
          resolveExec = resolve
        })
      )
    }

    const commandPromise = execCommand(conn as never, 'sleep 60', {
      signal: controller.signal
    })
    controller.abort()
    resolveExec(channel)

    await expect(commandPromise).rejects.toMatchObject({ name: 'AbortError' })
    expect(channel.close).toHaveBeenCalledOnce()
    expect(channel.listenerCount('error')).toBe(0)
    expect(channel.listenerCount('data')).toBe(0)
    expect(channel.listenerCount('close')).toBe(0)
    expect(channel.stderr.listenerCount('error')).toBe(0)
    expect(channel.stderr.listenerCount('data')).toBe(0)
  })

  it('uses custom command timeouts without forwarding them to SSH exec', async () => {
    vi.useFakeTimers()
    try {
      const channel = createMockChannel()
      const conn = {
        exec: vi.fn().mockResolvedValue(channel)
      }
      const commandPromise = execCommand(conn as never, 'npm install', {
        wrapCommand: false,
        timeoutMs: 240_000
      })

      await Promise.resolve()
      expect(conn.exec).toHaveBeenCalledWith('npm install', { wrapCommand: false })
      const rejection = expect(commandPromise).rejects.toThrow('timed out after 240s')
      await vi.advanceTimersByTimeAsync(240_000)

      await rejection
      expect(channel.close).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
})
