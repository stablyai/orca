import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SshChannelMultiplexer, type MultiplexerTransport } from './ssh-channel-multiplexer'
import { encodeFrame, encodeKeepAliveFrame, HEADER_LENGTH, MessageType } from './relay-protocol'

type MockTransport = MultiplexerTransport & {
  data: (chunk: Buffer) => void
  written: Buffer[]
  pauseReads: ReturnType<typeof vi.fn>
  resumeReads: ReturnType<typeof vi.fn>
}

type MuxInternals = {
  nextOutgoingSeq: number
  highestAckedBySelf: number
  lastReceivedAt: number
  decoderReadPaused: boolean
  unackedTimestamps: Map<number, number>
}

function createTransport(): MockTransport {
  let onData: (chunk: Buffer) => void = () => {}
  const written: Buffer[] = []
  const pauseReads = vi.fn()
  const resumeReads = vi.fn()
  return {
    write: (data) => {
      written.push(data)
    },
    onData: (callback) => {
      onData = callback
    },
    onClose: () => {},
    pauseReads,
    resumeReads,
    data: (chunk) => onData(chunk),
    written
  }
}

function internals(mux: SshChannelMultiplexer): MuxInternals {
  return mux as unknown as MuxInternals
}

describe('SshChannelMultiplexer backpressure hardening', () => {
  let transport: MockTransport
  let mux: SshChannelMultiplexer

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    transport = createTransport()
    mux = new SshChannelMultiplexer(transport)
  })

  afterEach(() => {
    mux.dispose()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('clamps ack=0xffffffff and deletes only retained sequence keys', () => {
    mux.notify('one')
    mux.notify('two')
    const state = internals(mux)
    const deleteSpy = vi.spyOn(state.unackedTimestamps, 'delete')

    transport.data(encodeKeepAliveFrame(1, 0xffffffff))

    expect(deleteSpy).toHaveBeenCalledTimes(2)
    expect(state.unackedTimestamps.size).toBe(0)
    expect(state.highestAckedBySelf).toBe(state.nextOutgoingSeq - 1)
  })

  it('caps timestamps while preserving a reserved liveness entry', () => {
    for (let i = 0; i < 5000; i += 1) {
      mux.notify('bounded')
    }
    const state = internals(mux)

    expect(state.unackedTimestamps.size).toBe(4095)
    expect(state.unackedTimestamps.has(1)).toBe(true)
    void mux.probeLiveness(60_000)
    expect(state.unackedTimestamps.size).toBe(4096)
    void mux.probeLiveness(60_000)
    expect(state.unackedTimestamps.size).toBe(4096)
  })

  it('suppresses timeout while self-paused and rebases both clocks on resume', () => {
    mux.dispose()
    const continuations: (() => void)[] = []
    vi.spyOn(globalThis, 'setImmediate').mockImplementation(
      (callback: (...args: never[]) => void) => {
        continuations.push(callback)
        return {} as NodeJS.Immediate
      }
    )
    transport = createTransport()
    mux = new SshChannelMultiplexer(transport)
    mux.notify('tracked')

    const incoming = Buffer.concat(
      Array.from({ length: 65 }, (_, index) => encodeKeepAliveFrame(index + 1, 0))
    )
    transport.data(incoming)
    const state = internals(mux)

    expect(state.decoderReadPaused).toBe(true)
    expect(transport.pauseReads).toHaveBeenCalledTimes(1)
    expect(continuations).toHaveLength(1)

    vi.advanceTimersByTime(25_000)
    expect(mux.isDisposed()).toBe(false)

    continuations.shift()!()
    const resumedAt = Date.now()
    expect(state.decoderReadPaused).toBe(false)
    expect(transport.resumeReads).toHaveBeenCalledTimes(1)
    expect(state.lastReceivedAt).toBe(resumedAt)
    expect(new Set(state.unackedTimestamps.values())).toEqual(new Set([resumedAt]))
  })

  it('keeps frame dispatch ordered across a decoder continuation', () => {
    const seen: number[] = []
    mux.onNotification((_method, params) => seen.push(params.index as number))
    const frames = Array.from({ length: 65 }, (_, index) => {
      const payload = Buffer.from(
        JSON.stringify({ jsonrpc: '2.0', method: 'ordered', params: { index } })
      )
      return encodeFrame(MessageType.Regular, index + 1, 0, payload)
    })

    transport.data(Buffer.concat(frames))
    expect(seen).toEqual(Array.from({ length: 64 }, (_, index) => index))
    vi.runAllTicks()
    vi.advanceTimersByTime(0)
    expect(seen).toEqual(Array.from({ length: 65 }, (_, index) => index))
  })

  it('prioritizes source ACK and control while preserving FIFO and ordinary progress', async () => {
    mux.dispose()
    const written: Buffer[] = []
    let drain = (): void => {}
    let deliver = (_data: Buffer): void => {}
    transport = {
      write: (data) => {
        written.push(data)
        return written.length !== 1
      },
      onDrain: (callback) => {
        drain = callback
      },
      onData: (callback) => {
        deliver = callback
      },
      onClose: vi.fn(),
      pauseReads: vi.fn<() => void>(),
      resumeReads: vi.fn<() => void>(),
      data: vi.fn<(chunk: Buffer) => void>(),
      written,
      close: vi.fn()
    }
    mux = new SshChannelMultiplexer(transport)
    mux.onRequest('client.control', () => ({ accepted: true }))
    const controller = new AbortController()

    mux.notify('pty.data', { id: 'pty-1', data: 'ordinary-1' })
    mux.notify('pty.data', { id: 'pty-1', data: 'ordinary-2' })
    mux.notify('pty.data', { id: 'pty-1', data: 'ordinary-3' })
    mux.notify('pty.ackData', { acknowledgements: [] })
    const request = mux.request('fs.scan', {}, { signal: controller.signal })
    controller.abort()
    mux.notify('pty.exit', { id: 'pty-1', code: 0 })
    const remoteRequest = Buffer.from(
      JSON.stringify({ jsonrpc: '2.0', id: 91, method: 'client.control' })
    )
    deliver(encodeFrame(MessageType.Regular, 1, 0, remoteRequest))
    await Promise.resolve()
    await Promise.resolve()

    expect(written).toHaveLength(1)
    drain()
    const payloads = written.map((frame) =>
      JSON.parse(frame.subarray(HEADER_LENGTH, HEADER_LENGTH + frame.readUInt32BE(9)).toString())
    )
    expect(
      payloads.map((payload) =>
        payload.method === 'pty.data'
          ? `pty.data:${payload.params.data}`
          : (payload.method ?? `response:${payload.id}`)
      )
    ).toEqual([
      'pty.data:ordinary-1',
      'pty.ackData',
      'fs.scan',
      'rpc.cancel',
      'pty.exit',
      'pty.data:ordinary-2',
      'response:91',
      'pty.data:ordinary-3'
    ])
    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
  })
})
