import './unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { RuntimeTerminalSend } from '../../../shared/runtime-types'
import { WRITE_ACCEPTED, writeUnverifiable } from '../../../shared/pty-write-settlement'
import {
  TerminalStreamOpcode,
  encodeTerminalStreamText
} from '../../../shared/terminal-stream-protocol'
import {
  sendDesktopMultiplexSubscribe,
  startDesktopMultiplexSubscribe
} from './terminal-multiplex-test-harness'

describe('terminal multiplex input receipts', () => {
  it.each([true, false])(
    'publishes receipts only after negotiated owner settlement (negotiated=%s)',
    async (negotiated) => {
      let settle: ((result: RuntimeTerminalSend) => void) | undefined
      const sendTerminal = vi.fn<OrcaRuntimeService['sendTerminal']>(
        () =>
          new Promise<RuntimeTerminalSend>((resolve) => {
            settle = resolve
          })
      )
      const harness = startDesktopMultiplexSubscribe({ sendTerminal })
      try {
        await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
        sendDesktopMultiplexSubscribe(harness.handlers, negotiated ? { ackInput: 1 } : {})
        await vi.waitFor(() =>
          expect(
            harness.messages.some((message) => JSON.parse(message).result?.type === 'subscribed')
          ).toBe(true)
        )
        harness.handlers.get(7)?.({
          opcode: TerminalStreamOpcode.Input,
          streamId: 7,
          seq: 42,
          payload: encodeTerminalStreamText('x')
        })
        await vi.waitFor(() => expect(sendTerminal).toHaveBeenCalledOnce())
        const receipts = () =>
          harness.messages
            .map((message) => JSON.parse(message).result)
            .filter((event) => event?.type === 'input-ack')
        expect(receipts()).toEqual([])
        expect(sendTerminal.mock.calls[0]?.[2]).toEqual(
          negotiated
            ? { inputKind: 'driving', requireWriteSettlement: true }
            : { inputKind: 'driving' }
        )
        settle?.({
          handle: 'terminal-1',
          accepted: true,
          bytesWritten: 1,
          writeSettlement: WRITE_ACCEPTED
        })
        if (negotiated) {
          await vi.waitFor(() =>
            expect(receipts()).toEqual([
              { type: 'input-ack', streamId: 7, seq: 42, outcome: 'accepted' }
            ])
          )
        } else {
          await vi.waitFor(() =>
            expect(sendTerminal.mock.results[0]?.value).resolves.toMatchObject({ accepted: true })
          )
          expect(receipts()).toEqual([])
        }
      } finally {
        harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
        await harness.dispatchPromise
      }
    }
  )

  it('preserves unverifiable delivery instead of acknowledging acceptance or refusal', async () => {
    const sendTerminal = vi.fn().mockResolvedValue({
      handle: 'terminal-1',
      accepted: false,
      bytesWritten: 0,
      writeSettlement: writeUnverifiable('transport_settlement_lost', true)
    })
    const harness = startDesktopMultiplexSubscribe({ sendTerminal })
    try {
      await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
      sendDesktopMultiplexSubscribe(harness.handlers, { ackInput: 1 })
      await vi.waitFor(() =>
        expect(
          harness.messages.some((message) => JSON.parse(message).result?.type === 'subscribed')
        ).toBe(true)
      )
      harness.handlers.get(7)?.({
        opcode: TerminalStreamOpcode.Input,
        streamId: 7,
        seq: 42,
        payload: encodeTerminalStreamText('x')
      })
      await vi.waitFor(() =>
        expect(harness.messages.map((message) => JSON.parse(message).result)).toContainEqual({
          type: 'input-ack',
          streamId: 7,
          seq: 42,
          outcome: 'unverifiable'
        })
      )
    } finally {
      harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
      await harness.dispatchPromise
    }
  })
})
