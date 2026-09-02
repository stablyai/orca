import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  MULTIPLEXER_CONTROL_RESERVE_BYTES,
  MULTIPLEXER_ORDINARY_QUEUE_MAX_BYTES,
  SshMultiplexerTransportWriter,
  type MultiplexerTransport,
  type MultiplexerWriteSettlement
} from './ssh-multiplexer-transport-writer'

type WriterHarness = {
  transport: MultiplexerTransport
  drain: () => void
  writes: Buffer[]
  callbacks: ((result: MultiplexerWriteSettlement) => void)[]
  removeDrain: ReturnType<typeof vi.fn>
}

function transportHarness(writeResults: (boolean | void)[]): WriterHarness {
  const emitter = new EventEmitter()
  const writes: Buffer[] = []
  const callbacks: ((result: MultiplexerWriteSettlement) => void)[] = []
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
  it('selects queued control before ordinary backlog at the drain boundary', () => {
    const harness = transportHarness([false, true, true, true])
    const writer = new SshMultiplexerTransportWriter(harness.transport, vi.fn())

    writer.enqueue(Buffer.from('ordinary-1'), 'ordinary')
    writer.enqueue(Buffer.from('ordinary-2'), 'ordinary')
    writer.enqueue(Buffer.from('ordinary-3'), 'ordinary')
    writer.enqueue(Buffer.from('control'), 'control')

    expect(harness.writes.map(String)).toEqual(['ordinary-1'])
    harness.drain()
    expect(harness.writes.map(String)).toEqual([
      'ordinary-1',
      'control',
      'ordinary-2',
      'ordinary-3'
    ])
    writer.dispose()
  })

  it('preserves FIFO within each lane and prevents ordinary starvation', () => {
    const harness = transportHarness([false, ...Array<boolean>(8).fill(true)])
    const writer = new SshMultiplexerTransportWriter(harness.transport, vi.fn())

    writer.enqueue(Buffer.from('ordinary-1'), 'ordinary')
    writer.enqueue(Buffer.from('ordinary-2'), 'ordinary')
    for (let index = 1; index <= 6; index++) {
      writer.enqueue(Buffer.from(`control-${index}`), 'control')
    }

    harness.drain()
    expect(harness.writes.map(String)).toEqual([
      'ordinary-1',
      'control-1',
      'control-2',
      'control-3',
      'control-4',
      'ordinary-2',
      'control-5',
      'control-6'
    ])
    writer.dispose()
  })

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
    expect(settlements[0]).toHaveBeenCalledWith({ ok: true })
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

  it('reports saturated epochs and their drain boundary exactly once', () => {
    const harness = transportHarness([false])
    const saturation = vi.fn()
    const writer = new SshMultiplexerTransportWriter(harness.transport, vi.fn(), saturation)

    writer.enqueue(Buffer.from('ordinary'), 'ordinary')
    writer.enqueue(Buffer.from('queued'), 'ordinary')
    expect(saturation.mock.calls).toEqual([[true]])

    harness.drain()
    expect(saturation.mock.calls).toEqual([[true], [false]])
    writer.dispose()
  })

  it('keeps a full ordinary lane from consuming the control reserve', () => {
    const harness = transportHarness([false, true, true])
    const writer = new SshMultiplexerTransportWriter(harness.transport, vi.fn())

    expect(writer.enqueue(Buffer.alloc(1), 'ordinary')).toBe(true)
    expect(writer.enqueue(Buffer.alloc(MULTIPLEXER_ORDINARY_QUEUE_MAX_BYTES - 1), 'ordinary')).toBe(
      true
    )
    expect(writer.enqueue(Buffer.alloc(MULTIPLEXER_CONTROL_RESERVE_BYTES), 'control')).toBe(true)

    expect(harness.writes).toHaveLength(1)
    harness.drain()
    expect(harness.writes).toHaveLength(3)
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
    expect(first).toHaveBeenCalledWith({ ok: false, error })
    expect(queued).toHaveBeenCalledWith({ ok: false, error })
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
      ok: false,
      error: expect.objectContaining({ message: expect.stringContaining('bounded capacity') })
    })
    expect(retained).toHaveBeenCalledWith({
      ok: false,
      error: expect.objectContaining({ message: expect.stringContaining('bounded capacity') })
    })
    expect(failed).toHaveBeenCalledOnce()
  })

  it('settles legacy callback-less transports on acceptance and drain', () => {
    const emitter = new EventEmitter()
    const write = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(undefined)
    const transport: MultiplexerTransport = {
      write,
      onDrain: (callback) => {
        emitter.on('drain', callback)
      },
      onData: vi.fn(),
      onClose: vi.fn()
    }
    const writer = new SshMultiplexerTransportWriter(transport, vi.fn())
    const first = vi.fn()
    const second = vi.fn()

    writer.enqueue(Buffer.from('first'), 'ordinary', first)
    writer.enqueue(Buffer.from('second'), 'control', second)
    expect(first).not.toHaveBeenCalled()
    expect(second).not.toHaveBeenCalled()

    emitter.emit('drain')
    expect(first).toHaveBeenCalledWith({ ok: true })
    expect(second).toHaveBeenCalledWith({ ok: true })
  })

  it('does not miss a drain emitted synchronously by a hostile transport', () => {
    let drain = (): void => {}
    const write = vi.fn(() => {
      drain()
      return false
    })
    const writer = new SshMultiplexerTransportWriter(
      {
        write,
        onDrain: (callback) => {
          drain = callback
        },
        onData: vi.fn(),
        onClose: vi.fn()
      },
      vi.fn()
    )
    const first = vi.fn()
    const second = vi.fn()

    writer.enqueue(Buffer.from('first'), 'ordinary', first)
    writer.enqueue(Buffer.from('second'), 'control', second)

    expect(write).toHaveBeenCalledTimes(2)
    expect(first).toHaveBeenCalledWith({ ok: true })
    expect(second).toHaveBeenCalledWith({ ok: true })
  })

  it('fails deterministically when write(false) has no drain source', () => {
    const failed = vi.fn()
    const writer = new SshMultiplexerTransportWriter(
      {
        write: () => false,
        onData: vi.fn(),
        onClose: vi.fn()
      },
      failed
    )
    const settled = vi.fn()

    expect(writer.enqueue(Buffer.from('data'), 'ordinary', settled)).toBe(true)
    expect(settled).toHaveBeenCalledWith({
      ok: false,
      error: expect.objectContaining({ message: expect.stringContaining('without drain support') })
    })
    expect(failed).toHaveBeenCalledOnce()
  })
})
