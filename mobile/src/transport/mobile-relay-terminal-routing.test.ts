import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileRelayRpcStreams } from './mobile-relay-rpc-streams'
import * as protocol from './terminal-stream-protocol'

const outputFrame = {
  opcode: protocol.TerminalStreamOpcode.Output,
  streamId: 42,
  seq: 3,
  payload: protocol.encodeTerminalStreamText('terminal output')
}
const outputBytes = protocol.encodeTerminalStreamFrame(outputFrame)

function setup() {
  let sequence = 0
  return new MobileRelayRpcStreams({
    nextId: () => `request-${++sequence}`,
    sendFrame: () => true,
    waitForConnected: async () => {}
  })
}

describe('relay terminal binary routing', () => {
  afterEach(() => vi.restoreAllMocks())

  it('decodes native terminal output only once without a hosted multiplex subscription', async () => {
    const streams = setup()
    const listener = vi.fn()
    streams.subscribe('terminal.subscribe', { terminal: 'term' }, listener)
    await Promise.resolve()
    streams.handleResponse({
      id: 'request-1',
      ok: true,
      streaming: true,
      result: { type: 'subscribed', streamId: 42 },
      _meta: { runtimeId: 'runtime' }
    })
    listener.mockClear()
    const decode = vi.spyOn(protocol, 'decodeTerminalStreamFrame')

    streams.handleBinary(outputBytes)

    expect(listener).toHaveBeenCalledExactlyOnceWith({
      type: 'data',
      streamId: 42,
      chunk: 'terminal output'
    })
    expect(decode).toHaveBeenCalledOnce()
  })

  it('routes hosted frames once and fences them after cancellation', async () => {
    const streams = setup()
    const onTerminalBinaryFrame = vi.fn(() => true)
    const cancel = streams.subscribe('terminal.multiplex', {}, vi.fn(), { onTerminalBinaryFrame })
    await Promise.resolve()
    streams.handleResponse({
      id: 'request-1',
      ok: true,
      streaming: true,
      result: { type: 'ready' },
      _meta: { runtimeId: 'runtime' }
    })
    const decode = vi.spyOn(protocol, 'decodeTerminalStreamFrame')

    streams.handleBinary(outputBytes)

    expect(onTerminalBinaryFrame).toHaveBeenCalledExactlyOnceWith(outputFrame)
    expect(decode).toHaveBeenCalledOnce()
    cancel()
    streams.handleBinary(outputBytes)
    expect(onTerminalBinaryFrame).toHaveBeenCalledOnce()
  })
})
