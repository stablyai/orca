import './unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson
} from '../../../shared/terminal-stream-protocol'
import {
  sendDesktopMultiplexSubscribe,
  startDesktopMultiplexSubscribe
} from './terminal-multiplex-test-harness'

type DataListener = (data: string, meta?: { seq?: number; rawLength?: number }) => void

// Snapshot frames bypass the ACK window, so a history-carrying recovery on every ACK of a
// sustained flood outgrew what the client could take in and the host backlog never settled.
describe('ACK-overflow recovery history under a sustained flood', () => {
  it('stays screen-only while the link is saturated and sends history once it drains', async () => {
    let seq = 0
    const listener: { current?: DataListener } = {}
    const serializeTerminalBuffer = vi.fn(
      async (_ptyId: string, opts?: { scrollbackRows?: number }) => ({
        data: (opts?.scrollbackRows ?? 0) > 0 ? 'history\r\nscreen' : 'screen',
        cols: 120,
        rows: 40,
        seq
      })
    )
    const harness = startDesktopMultiplexSubscribe({
      serializeTerminalBuffer,
      subscribeToTerminalData: vi.fn((_: string, next: DataListener) => {
        listener.current = next
        return vi.fn()
      })
    })
    await vi.waitFor(() =>
      expect(harness.messages.some((m) => JSON.parse(m).result?.type === 'ready')).toBe(true)
    )
    sendDesktopMultiplexSubscribe(harness.handlers)
    await vi.waitFor(() =>
      expect(harness.messages.some((m) => JSON.parse(m).result?.type === 'subscribed')).toBe(true)
    )
    harness.binaryFrames.splice(0)

    let inFlight = 0
    let ackSeq = 2
    const takeSent = (): { output: number; recoveryRows: number[] } => {
      const frames = harness.binaryFrames.splice(0).map(decodeTerminalStreamFrame)
      const output = frames
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
        .reduce((total, frame) => total + (frame?.payload.byteLength ?? 0), 0)
      const recoveryRows = frames.flatMap((frame) => {
        if (frame?.opcode !== TerminalStreamOpcode.SnapshotStart) {
          return []
        }
        const meta = decodeTerminalStreamJson<{ reason?: string; scrollbackRows?: number }>(
          frame.payload
        )
        return meta?.reason === 'ack-pending-overflow' ? [meta.scrollbackRows ?? -1] : []
      })
      inFlight += output
      return { output, recoveryRows }
    }
    const ack = async (bytes: number): Promise<{ output: number; recoveryRows: number[] }> => {
      inFlight -= bytes
      harness.handlers.get(7)?.(
        decodeTerminalStreamFrame(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.Ack,
            streamId: 7,
            seq: ackSeq++,
            payload: encodeTerminalStreamJson({ bytes })
          })
        )!
      )
      await vi.waitFor(() =>
        expect(serializeTerminalBuffer.mock.results.at(-1)?.type).toBe('return')
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
      return takeSent()
    }
    const flood = (): void => {
      const chunk = 'x'.repeat(1024 * 1024)
      seq += chunk.length
      listener.current?.(chunk, { seq, rawLength: chunk.length })
    }

    flood()
    takeSent()
    const duringFlood: number[] = []
    for (let round = 0; round < 5; round++) {
      // The client acks one batch while the flood keeps the window full.
      duringFlood.push(...(await ack(192 * 1024)).recoveryRows)
      flood()
      takeSent()
    }
    expect(duringFlood.length).toBeGreaterThan(0)
    expect(duringFlood.every((rows) => rows === 0)).toBe(true)

    // The flood stops and the client catches up: one recovery replaces the screen-only image.
    const settled: number[] = []
    for (let round = 0; round < 10 && inFlight > 0; round++) {
      settled.push(...(await ack(inFlight)).recoveryRows)
    }
    expect(inFlight).toBe(0)
    expect(settled).toEqual([1000])
    expect(serializeTerminalBuffer).toHaveBeenLastCalledWith('pty-1', { scrollbackRows: 1000 })

    harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
    await harness.dispatchPromise
  })
})
