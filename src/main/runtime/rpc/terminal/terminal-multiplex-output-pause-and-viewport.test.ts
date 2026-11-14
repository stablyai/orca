import { describe, expect, it, vi } from 'vitest'

import type { RuntimeTerminalDataMeta } from '../../terminal/output/runtime-terminal-stream-consumers'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamText,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson
} from '../../../../shared/terminal/stream/terminal-stream-protocol'
import {
  SET_OUTPUT_PAUSED_OPCODE,
  startDesktopMultiplexSubscribe
} from './testing/terminal-multiplex-test-harness'

describe('terminal multiplex RPC', () => {
  it('withholds sustained output from multiple paused desktop streams', async () => {
    const listeners: ((data: string, meta?: RuntimeTerminalDataMeta) => void)[] = []
    const harness = startDesktopMultiplexSubscribe({
      subscribeToTerminalData: vi.fn((_ptyId, listener) => {
        listeners.push(listener)
        return vi.fn()
      }),
      serializeAuthoritativeTerminalBuffer: vi.fn().mockResolvedValue({
        data: 'authoritative hidden snapshot',
        cols: 120,
        rows: 40,
        seq: 7,
        source: 'headless'
      })
    })
    await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))

    for (const streamId of [1, 2, 3]) {
      harness.handlers.get(0)?.(
        decodeTerminalStreamFrame(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.Subscribe,
            streamId: 0,
            seq: streamId,
            payload: encodeTerminalStreamJson({
              streamId,
              terminal: `terminal-${streamId}`,
              client: { id: `desktop-${streamId}`, type: 'desktop' },
              capabilities: { ackOutput: 1, outputPause: 1 }
            })
          })
        )!
      )
    }
    await vi.waitFor(() =>
      expect(
        harness.messages.filter((message) => JSON.parse(message).result?.type === 'subscribed')
      ).toHaveLength(3)
    )
    const pauseCapable = harness.messages
      .map((message) => JSON.parse(message).result)
      .filter((event) => event?.type === 'subscribed')
      .every((event) => event.capabilities?.outputPause === 1)
    if (pauseCapable) {
      for (const streamId of [1, 2, 3]) {
        harness.handlers.get(streamId)?.(
          decodeTerminalStreamFrame(
            encodeTerminalStreamFrame({
              opcode: SET_OUTPUT_PAUSED_OPCODE,
              streamId,
              seq: 10,
              payload: encodeTerminalStreamJson({ paused: true })
            })
          )!
        )
      }
    }
    harness.binaryFrames.splice(0)
    const chunk = 'x'.repeat(64 * 1024)
    for (let turn = 0; turn < 8; turn += 1) {
      for (const listener of listeners) {
        listener(chunk, { seq: (turn + 1) * chunk.length, rawLength: chunk.length })
      }
    }
    expect(
      harness.binaryFrames.some(
        (bytes) => decodeTerminalStreamFrame(bytes)?.opcode === TerminalStreamOpcode.Output
      )
    ).toBe(false)
    expect(pauseCapable).toBe(true)

    harness.handlers.get(1)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: SET_OUTPUT_PAUSED_OPCODE,
          streamId: 1,
          seq: 11,
          payload: encodeTerminalStreamJson({ paused: false })
        })
      )!
    )
    listeners[0]?.('VISIBLE_MARKER', { seq: 8 * chunk.length + 14, rawLength: 14 })
    listeners[0]?.('y'.repeat(64 * 1024), {
      seq: 9 * chunk.length + 14,
      rawLength: 64 * 1024
    })
    expect(
      harness.binaryFrames
        .map(decodeTerminalStreamFrame)
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
        .map((frame) => decodeTerminalStreamText(frame!.payload))
        .join('')
    ).toContain('VISIBLE_MARKER')

    harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
    await harness.dispatchPromise
    expect(harness.handlers.size).toBe(0)
  })
})
