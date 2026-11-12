import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  MULTIPLEXER_ORDINARY_QUEUE_MAX_BYTES,
  SshMultiplexerTransportWriter,
  type MultiplexerTransport,
  type MultiplexerTransportWriteResult
} from './ssh-multiplexer-transport-writer'

type WriterHarness = {
  transport: MultiplexerTransport
  drain: () => void
  writes: Buffer[]
  callbacks: ((result: MultiplexerTransportWriteResult) => void)[]
  removeDrain: ReturnType<typeof vi.fn>
}

function transportHarness(writeResults: (boolean | void)[]): WriterHarness {
  const emitter = new EventEmitter()
  const writes: Buffer[] = []
  const callbacks: ((result: MultiplexerTransportWriteResult) => void)[] = []
  const removeDrain = vi.fn()
  return {
    transport: {
      write: (data, onSettled) => {
        writes.push(data)
        callbacks.push(onSettled!)
        return writeResults.shift()
      },
      supportsWriteSettlement: true,
      onDrain: (callback) => {
        emitter.on('drain', callback)
        return () => {
          removeDrain()
          emitter.off('drain', callback)
        }
      },
      onData: vi.fn(),
      onClose: vi.fn()
    },
    drain: () => emitter.emit('drain'),
    writes,
    callbacks,
    removeDrain
  }
}

describe('SshMultiplexerTransportWriter', () => {
  it('waits for drain and settles each write once', () => {
    const harness = transportHarness([false, true, true])
    const failed = vi.fn()
    const writer = new SshMultiplexerTransportWriter(harness.transport, failed)
    const settlements = [vi.fn(), vi.fn(), vi.fn()]

    writer.enqueue(Buffer.from('ordinary-1'), 'ordinary', settlements[0])
    writer.enqueue(Buffer.from('control'), 'control', settlements[1])
    writer.enqueue(Buffer.from('ordinary-2'), 'ordinary', settlements[2])

    expect(harness.writes.map(String)).toEqual(['ordinary-1'])
    harness.callbacks[0]({ ok: true })
    expect(settlements[0]).toHaveBeenCalledWith({ outcome: 'accepted' })
    expect(harness.writes.map(String)).toEqual(['ordinary-1'])

    harness.drain()
    expect(harness.writes.map(String)).toEqual(['ordinary-1', 'control', 'ordinary-2'])
    harness.callbacks[1]({ ok: true })
    harness.callbacks[2]({ ok: true })
    expect(settlements.every((settle) => settle.mock.calls.length === 1)).toBe(true)
    expect(failed).not.toHaveBeenCalled()
  })

  it('allows one coalesced liveness bypass per saturated write settlement', () => {
    const harness = transportHarness([false, true, true, true])
    const writer = new SshMultiplexerTransportWriter(harness.transport, vi.fn())

    writer.enqueue(Buffer.from('ordinary-1'), 'ordinary')
    writer.enqueue(Buffer.from('ordinary-2'), 'ordinary')
    expect(writer.enqueue(Buffer.from('liveness-1'), 'liveness')).toBe(true)
    expect(writer.enqueue(Buffer.from('liveness-coalesced'), 'liveness')).toBe(false)
    expect(harness.writes.map(String)).toEqual(['ordinary-1', 'liveness-1'])

    harness.callbacks[1]({ ok: true })
    expect(writer.enqueue(Buffer.from('liveness-2'), 'liveness')).toBe(true)
    expect(harness.writes.map(String)).toEqual(['ordinary-1', 'liveness-1', 'liveness-2'])

    harness.drain()
    expect(harness.writes.map(String)).toEqual([
      'ordinary-1',
      'liveness-1',
      'liveness-2',
      'ordinary-2'
    ])
    writer.dispose()
  })

  it('fails all retained writes once when a callback reports an error', () => {
    const harness = transportHarness([false])
    const failed = vi.fn()
    const writer = new SshMultiplexerTransportWriter(harness.transport, failed)
    const first = vi.fn()
    const queued = vi.fn()
    const error = new Error('broken pipe')

    writer.enqueue(Buffer.from('first'), 'ordinary', first)
    writer.enqueue(Buffer.from('queued'), 'control', queued)
    harness.callbacks[0]({ ok: false, error })
    harness.callbacks[0]({ ok: true })

    expect(first).toHaveBeenCalledOnce()
    expect(first).toHaveBeenCalledWith({
      outcome: 'unverifiable',
      reason: 'transport_settlement_lost',
      bytesHandedToTransport: true,
      error
    })
    expect(queued).toHaveBeenCalledWith({
      outcome: 'refused',
      reason: 'transport_rejected_before_handoff',
      error
    })
    expect(failed).toHaveBeenCalledWith(error)
    expect(harness.removeDrain).toHaveBeenCalledOnce()
  })

  it('closes on queue overflow and rejects the overflowing write', () => {
    const harness = transportHarness([false])
    const failed = vi.fn()
    const writer = new SshMultiplexerTransportWriter(harness.transport, failed)
    const retained = vi.fn()
    const overflow = vi.fn()

    writer.enqueue(Buffer.alloc(MULTIPLEXER_ORDINARY_QUEUE_MAX_BYTES), 'ordinary', retained)
    expect(writer.enqueue(Buffer.alloc(1), 'ordinary', overflow)).toBe(false)

    expect(overflow).toHaveBeenCalledWith({
      outcome: 'refused',
      reason: 'transport_queue_full',
      error: expect.objectContaining({ message: expect.stringContaining('bounded capacity') })
    })
    expect(retained).toHaveBeenCalledWith({
      outcome: 'unverifiable',
      reason: 'transport_settlement_lost',
      bytesHandedToTransport: true,
      error: expect.objectContaining({ message: expect.stringContaining('bounded capacity') })
    })
    expect(failed).toHaveBeenCalledOnce()
  })
})
