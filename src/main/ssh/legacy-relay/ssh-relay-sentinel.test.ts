import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { ClientChannel } from 'ssh2'
import { waitForSentinel } from './ssh-relay-sentinel'
import { RELAY_SENTINEL } from '../remote-exec/remote-frame-protocol'
import {
  RelayVersionMismatchError,
  RELAY_EXIT_CODE_VERSION_MISMATCH
} from './ssh-relay-version-mismatch-error'
import {
  RelayCredentialMismatchError,
  RELAY_EXIT_CODE_CREDENTIAL_MISMATCH
} from './ssh-relay-credential-mismatch-error'

type MockChannel = ClientChannel & {
  stdin: EventEmitter & { write: ReturnType<typeof vi.fn> }
}

function createMockChannel(): MockChannel {
  return Object.assign(new EventEmitter(), {
    stderr: Object.assign(new EventEmitter(), { resume: vi.fn() }),
    stdin: Object.assign(new EventEmitter(), { write: vi.fn(() => true) }),
    close: vi.fn(),
    resume: vi.fn()
  }) as unknown as MockChannel
}

describe('waitForSentinel', () => {
  it('closes and rejects with AbortError while clearing startup resources on abort', async () => {
    vi.useFakeTimers()
    try {
      const channel = createMockChannel()
      const controller = new AbortController()
      const removeListener = vi.spyOn(controller.signal, 'removeEventListener')
      const transportPromise = waitForSentinel(channel, controller.signal)

      expect(vi.getTimerCount()).toBe(1)
      controller.abort()

      await expect(transportPromise).rejects.toMatchObject({ name: 'AbortError' })
      expect(channel.close).toHaveBeenCalledTimes(1)
      expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('removes the abort listener and timers when startup fails before the sentinel', async () => {
    vi.useFakeTimers()
    try {
      const channel = createMockChannel()
      const controller = new AbortController()
      const removeListener = vi.spyOn(controller.signal, 'removeEventListener')
      const transportPromise = waitForSentinel(channel, controller.signal)

      channel.emit('error', new Error('remote host rebooted'))

      await expect(transportPromise).rejects.toThrow('remote host rebooted')
      expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

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

  it('translates a pre-sentinel exit-43 + close into RelayCredentialMismatchError', async () => {
    const channel = createMockChannel()
    const transportPromise = waitForSentinel(channel)

    channel.stderr.emit(
      'data',
      Buffer.from('[relay-connect] Endpoint credential refused by daemon; exiting 43\n')
    )
    channel.emit('exit', RELAY_EXIT_CODE_CREDENTIAL_MISMATCH)
    channel.emit('close')

    await expect(transportPromise).rejects.toBeInstanceOf(RelayCredentialMismatchError)
    await transportPromise.catch((err: unknown) => {
      expect(err).not.toBeInstanceOf(RelayVersionMismatchError)
    })
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

  it.each(['ssh2 channel', 'system-SSH child stdio'])(
    'forwards write(false), callback settlement, and drain for a %s',
    async (channelKind) => {
      const channel = createMockChannel()
      if (channelKind.startsWith('system')) {
        Object.assign(channel, { _process: new EventEmitter() })
      }
      const callback = vi.fn()
      const drain = vi.fn()
      channel.stdin.write.mockImplementation((...args: unknown[]) => {
        const onWritten = args.find((arg) => typeof arg === 'function') as (
          error?: Error | null
        ) => void
        onWritten(null)
        return false
      })
      const transportPromise = waitForSentinel(channel)
      channel.emit('data', Buffer.from(RELAY_SENTINEL))
      const transport = await transportPromise

      transport.onDrain?.(drain)
      expect(transport.write(Buffer.from('frame'), callback)).toBe(false)
      expect(callback).toHaveBeenCalledWith({ ok: true })
      channel.stdin.emit('drain')
      expect(drain).toHaveBeenCalledOnce()
      expect(transport.supportsWriteSettlement).toBe(true)
    }
  )
})
