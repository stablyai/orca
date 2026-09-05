import { describe, expect, it } from 'vitest'
import {
  encodeTerminalStreamFrame,
  TerminalStreamOpcode
} from '@orca-shared/terminal-stream-protocol'
import { createHudStore, type HudState } from './hud-store'
import { TerminalTailController, type TailDecoder } from './terminal-tail-state'
import type { RpcPort, RpcResponse } from '../transport/orca-rpc-wire'

function fixtureState(): HudState {
  return {
    connection: { hostId: null, state: 'disconnected', compat: null },
    hosts: [],
    dashboard: { rows: [], fetchedAt: 0, stale: false },
    inbox: { entries: [] },
    terminalTail: { terminalId: null, lines: [], live: false },
    device: null,
    askAnswered: null,
    nav: { stack: [{ screen: 'pairing' }], exitDialogArmed: false }
  }
}

class FakeRpcPort implements RpcPort {
  onBinary: ((payload: Uint8Array) => void) | null = null
  lastSubscribeCall: { method: string; params: unknown } | null = null
  unsubscribeCalls = 0

  sendRequest(): Promise<RpcResponse> {
    throw new Error('not used by terminal-tail-state')
  }

  subscribe(
    method: string,
    params: unknown,
    _onData: (result: unknown) => void,
    onBinary?: (payload: Uint8Array) => void
  ): () => void {
    this.lastSubscribeCall = { method, params }
    this.onBinary = onBinary ?? null
    return () => {
      this.unsubscribeCalls++
    }
  }
}

/** Fake TailDecoder: records pushed frames and returns a scripted lines() result. */
function fakeDecoder() {
  const pushed: { opcode: number }[] = []
  let scriptedLines: string[] = []
  const decoder: TailDecoder = {
    pushFrame: (frame) => {
      pushed.push({ opcode: frame.opcode })
      scriptedLines = [...scriptedLines, `line-${pushed.length}`]
    },
    lines: () => scriptedLines
  }
  return { decoder, pushed }
}

function frameBytes(opcode: TerminalStreamOpcode, text = 'hello'): Uint8Array {
  return encodeTerminalStreamFrame({
    opcode,
    streamId: 1,
    seq: 1,
    payload: new TextEncoder().encode(text)
  })
}

describe('TerminalTailController', () => {
  it('open() subscribes to terminal.subscribe with the terminal id and sets live:true', () => {
    const store = createHudStore(fixtureState())
    const port = new FakeRpcPort()
    new TerminalTailController(store, { port, createDecoder: () => fakeDecoder().decoder }).open(
      'term-1'
    )

    expect(port.lastSubscribeCall).toEqual({
      method: 'terminal.subscribe',
      params: { terminal: 'term-1', viewport: { cols: 60, rows: 20 } }
    })
    expect(store.getState().terminalTail).toEqual({ terminalId: 'term-1', lines: [], live: true })
  })

  it('maps decoded binary frames through the decoder into terminalTail.lines', () => {
    const store = createHudStore(fixtureState())
    const port = new FakeRpcPort()
    const { decoder, pushed } = fakeDecoder()
    new TerminalTailController(store, { port, createDecoder: () => decoder }).open('term-1')

    port.onBinary?.(frameBytes(TerminalStreamOpcode.Output))

    expect(pushed).toEqual([{ opcode: TerminalStreamOpcode.Output }])
    expect(store.getState().terminalTail).toEqual({
      terminalId: 'term-1',
      lines: ['line-1'],
      live: true
    })
  })

  it('marks live:false on an Error opcode frame', () => {
    const store = createHudStore(fixtureState())
    const port = new FakeRpcPort()
    const { decoder } = fakeDecoder()
    new TerminalTailController(store, { port, createDecoder: () => decoder }).open('term-1')

    port.onBinary?.(frameBytes(TerminalStreamOpcode.Error))

    expect(store.getState().terminalTail.live).toBe(false)
  })

  it('ignores malformed binary payloads', () => {
    const store = createHudStore(fixtureState())
    const port = new FakeRpcPort()
    const { decoder, pushed } = fakeDecoder()
    new TerminalTailController(store, { port, createDecoder: () => decoder }).open('term-1')

    port.onBinary?.(new Uint8Array([1, 2, 3]))

    expect(pushed).toEqual([])
    expect(store.getState().terminalTail.lines).toEqual([])
  })

  it('close() unsubscribes and resets the slice', () => {
    const store = createHudStore(fixtureState())
    const port = new FakeRpcPort()
    const controller = new TerminalTailController(store, {
      port,
      createDecoder: () => fakeDecoder().decoder
    })
    controller.open('term-1')

    controller.close()

    expect(port.unsubscribeCalls).toBe(1)
    expect(store.getState().terminalTail).toEqual({ terminalId: null, lines: [], live: false })
  })

  it('re-opening a new terminal on the same controller drops frames from the superseded subscription', () => {
    const store = createHudStore(fixtureState())
    const port = new FakeRpcPort()
    const first = fakeDecoder()
    const second = fakeDecoder()
    let calls = 0
    const controller = new TerminalTailController(store, {
      port,
      createDecoder: () => (calls++ === 0 ? first.decoder : second.decoder)
    })

    controller.open('term-1')
    const staleOnBinary = port.onBinary // capture before open('term-2') rebinds port.onBinary
    controller.open('term-2') // no close() in between — simulates a fast re-open

    staleOnBinary?.(frameBytes(TerminalStreamOpcode.Output)) // arrives after supersession

    expect(first.pushed).toEqual([]) // superseded subscription's decoder never sees the frame
    expect(store.getState().terminalTail.terminalId).toBe('term-2')
    expect(store.getState().terminalTail.lines).toEqual([])
  })
})
