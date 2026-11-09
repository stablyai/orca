import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import type { MultiplexerTransport } from './ssh-multiplexer-transport-writer'
import { encodeFrame, MessageType } from './remote-frame-protocol'
import { HEADER_LENGTH } from '../../../shared/relay-frame-decoder'

type MockTransport = MultiplexerTransport & {
  data: (chunk: Buffer) => void
  written: Buffer[]
  pauseReads: ReturnType<typeof vi.fn>
  resumeReads: ReturnType<typeof vi.fn>
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
