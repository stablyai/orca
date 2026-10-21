import './unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'
import { stubRuntime, makeRequest } from './terminal-multiplex-test-harness'
import type { TerminalOutputMeta } from './terminal-output-frame-chunks'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  decodeTerminalStreamText
} from '../../../shared/terminal-stream-protocol'

describe('mobile subscribe residual metadata', () => {
  it.each([undefined, 5, 12])(
    'strips a snapshot-boundary query without changing transformed span rawLength %s',
    async (transformedRawLength) => {
      vi.useFakeTimers()
      const controller = new AbortController()
      try {
        const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
        let emitOutput: ((data: string, meta?: TerminalOutputMeta) => void) | undefined
        let releaseSnapshot: (() => void) | undefined
        const runtime = stubRuntime({
          resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
          handleMobileSubscribe: vi.fn().mockResolvedValue(true),
          handleMobileUnsubscribe: vi.fn(),
          subscribeToTerminalData: (_ptyId, listener) => {
            emitOutput = listener
            return vi.fn()
          },
          readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
          serializeTerminalBuffer: vi.fn(async () => {
            await new Promise<void>((resolve) => {
              releaseSnapshot = resolve
            })
            // The snapshot ends inside the cursor-position query in the buffered output.
            return { data: 'before', cols: 40, rows: 24, seq: 8 }
          }),
          getTerminalSize: vi.fn().mockReturnValue({ cols: 40, rows: 24 }),
          getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
          getLayout: vi.fn().mockReturnValue({ seq: 1 }),
          isTerminalAlternateScreen: vi.fn().mockReturnValue(false),
          subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
          subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn())
        })
        const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
        const dispatchPromise = dispatcher.dispatchStreaming(
          makeRequest('terminal.subscribe', {
            terminal: 'terminal-1',
            client: { id: 'phone-1', type: 'mobile' },
            capabilities: { terminalBinaryStream: 1 }
          }),
          vi.fn(),
          {
            signal: controller.signal,
            connectionId: 'phone-connection',
            sendBinary: (bytes) => {
              binaryFrames.push(bytes)
            },
            registerBinaryStreamHandler: vi.fn(() => vi.fn())
          }
        )
        await vi.runOnlyPendingTimersAsync()
        expect(releaseSnapshot).toBeTypeOf('function')
        emitOutput?.('before\x1b[6nafter', { seq: 15, rawLength: 15 })
        if (transformedRawLength !== undefined) {
          emitOutput?.('PAINT', {
            seq: 15 + transformedRawLength,
            rawLength: transformedRawLength,
            transformed: true,
            cwd: '/workspace'
          })
        }
        releaseSnapshot?.()
        await vi.runOnlyPendingTimersAsync()

        const frames = binaryFrames.flatMap((bytes) => {
          const frame = decodeTerminalStreamFrame(bytes)
          return frame ? [frame] : []
        })
        const output = frames.filter(
          (frame) =>
            frame.opcode === TerminalStreamOpcode.Output ||
            frame.opcode === TerminalStreamOpcode.OutputSpan
        )
        expect(
          output.map((frame) => ({
            opcode: frame.opcode,
            seq: frame.seq,
            payload:
              frame.opcode === TerminalStreamOpcode.Output
                ? decodeTerminalStreamText(frame.payload)
                : decodeTerminalStreamJson(frame.payload)
          }))
        ).toEqual([
          { opcode: TerminalStreamOpcode.Output, seq: 15, payload: '\x1b[6nafter' },
          ...(transformedRawLength === undefined
            ? []
            : [
                {
                  opcode: TerminalStreamOpcode.OutputSpan,
                  seq: 15 + transformedRawLength,
                  payload: { data: 'PAINT', rawLength: transformedRawLength, transformed: true }
                }
              ])
        ])
        if (transformedRawLength !== undefined) {
          expect(
            frames
              .filter((frame) => frame.opcode === TerminalStreamOpcode.Metadata)
              .map((frame) => decodeTerminalStreamJson(frame.payload))
          ).toEqual([{ cwd: '/workspace' }])
        }
        controller.abort()
        await dispatchPromise
      } finally {
        controller.abort()
        vi.useRealTimers()
      }
    }
  )
})
