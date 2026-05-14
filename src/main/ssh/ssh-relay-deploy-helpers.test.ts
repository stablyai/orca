import { EventEmitter } from 'events'
import { describe, expect, it, vi } from 'vitest'
import type { ClientChannel } from 'ssh2'
import { execCommand, waitForSentinel } from './ssh-relay-deploy-helpers'
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
  })
})
