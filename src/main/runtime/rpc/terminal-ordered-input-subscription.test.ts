import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'
import { makeRequest, stubRuntime } from './terminal-multiplex-test-harness'
import { createSubscriptionRegistryDouble } from './subscription-registry-test-double'
import { TERMINAL_ORDERED_INPUT_CAPABILITY } from '../../../shared/terminal-ordered-input'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  encodeTerminalStreamFrame,
  encodeTerminalStreamText,
  type TerminalStreamFrame
} from '../../../shared/terminal-stream-protocol'
import type { OrcaRuntimeService } from '../orca-runtime'

async function subscribe(
  options: {
    ordered?: boolean
    mobile?: boolean
    fail?: 'before' | 'after'
    writeUnavailable?: boolean
  } = {}
) {
  const messages: string[] = []
  const frames: TerminalStreamFrame[] = []
  const handlers = new Map<number, (frame: TerminalStreamFrame) => void>()
  const registry = createSubscriptionRegistryDouble()
  let rejectBinary = false
  let currentPtyId = 'pty-1'
  let currentGeneration = 1
  const sendTerminal = vi.fn(async (_handle, _action, writeOptions) => {
    if (options.fail === 'before') {
      throw new Error('terminal_not_writable')
    }
    writeOptions?.reserveWrite?.('pty-1')
    if (options.fail === 'after') {
      throw new Error('provider connection lost')
    }
    await writeOptions?.afterWrite?.('pty-1')
    return { accepted: true, bytesWritten: 1, handle: 'terminal-1' }
  })
  const runtime = stubRuntime({
    captureTerminalInputArrivalTarget: () => {
      const ptyId = currentPtyId
      const generation = currentGeneration
      return {
        ptyId,
        generation,
        assertCurrent: () => {
          if (ptyId !== currentPtyId || generation !== currentGeneration) {
            throw new Error('terminal_handle_stale')
          }
        }
      }
    },
    resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
    readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
    serializeTerminalBuffer: vi.fn().mockResolvedValue({ data: 'snapshot', cols: 120, rows: 40 }),
    hasHeadlessTerminalState: vi.fn().mockReturnValue(true),
    getRendererTerminalSerializerGenerationForHandle: vi.fn().mockReturnValue(1),
    getTerminalSize: vi.fn().mockReturnValue({ cols: 120, rows: 40 }),
    getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
    getLayout: vi.fn().mockReturnValue({ seq: 123 }),
    subscribeToTerminalData: vi.fn().mockReturnValue(vi.fn()),
    subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
    subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
    getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
    handleMobileSubscribe: vi.fn().mockResolvedValue(undefined),
    handleMobileUnsubscribe: vi.fn(),
    beginMobileInputFloor: vi.fn(() => ({ commit: async () => {}, rollback: () => {} })),
    registerSubscriptionCleanup: vi.fn(registry.registerSubscriptionCleanup),
    registerOwnedSubscriptionCleanup: vi.fn(registry.registerOwnedSubscriptionCleanup),
    cleanupSubscription: vi.fn(registry.cleanupSubscription),
    sendTerminal: sendTerminal as OrcaRuntimeService['sendTerminal']
  })
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
  const finished = dispatcher.dispatchStreaming(
    makeRequest('terminal.subscribe', {
      terminal: 'terminal-1',
      client: { id: 'client-1', type: options.mobile === false ? 'desktop' : 'mobile' },
      capabilities: {
        terminalBinaryStream: 1,
        ...(options.ordered ? { orderedInput: 1 } : {}),
        ...(options.writeUnavailable ? { writeUnavailable: 1 } : {})
      }
    }),
    (message) => messages.push(message),
    {
      connectionId: 'ordered-input-test',
      sendBinary: (bytes) => {
        if (rejectBinary) {
          return false
        }
        frames.push(decodeTerminalStreamFrame(bytes)!)
        return true
      },
      registerBinaryStreamHandler: (streamId, handler) => {
        handlers.set(streamId, handler)
        return () => {
          handlers.delete(streamId)
        }
      }
    }
  )
  await vi.waitFor(() =>
    expect(messages.some((message) => JSON.parse(message).result?.type === 'subscribed')).toBe(true)
  )
  const subscribed = JSON.parse(
    messages.find((message) => JSON.parse(message).result?.type === 'subscribed')!
  ).result
  const receipts = () =>
    frames
      .filter((frame) => frame.opcode === TerminalStreamOpcode.Metadata)
      .map(
        (frame) => decodeTerminalStreamJson<{ inputReceipt?: unknown }>(frame.payload)?.inputReceipt
      )
      .filter(Boolean)
  return {
    subscribed,
    receipts,
    frames,
    sendTerminal,
    handlers,
    finished,
    rejectBinary: () => {
      rejectBinary = true
    },
    replaceTarget: (samePtyId: boolean) => {
      currentPtyId = samePtyId ? 'pty-1' : 'pty-2'
      currentGeneration++
    },
    close: () => runtime.cleanupSubscription('terminal-1:client-1'),
    input: (seq: number, text: string) =>
      handlers.get(subscribed.streamId)?.(
        decodeTerminalStreamFrame(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.Input,
            streamId: subscribed.streamId,
            seq,
            payload: encodeTerminalStreamText(text)
          })
        )!
      )
  }
}

describe('legacy mobile ordered input subscription', () => {
  it('reports stale legacy input through the negotiated recovery opcode', async () => {
    const test = await subscribe({ writeUnavailable: true })
    test.replaceTarget(false)
    test.input(0, 'stale')
    await vi.waitFor(() =>
      expect(
        test.frames.some((frame) => frame.opcode === TerminalStreamOpcode.WriteUnavailable)
      ).toBe(true)
    )
    expect(test.sendTerminal).not.toHaveBeenCalled()
    test.close()
    await test.finished
  })

  it.each([false, true])(
    'rejects delayed input after replacement (same PTY id: %s)',
    async (samePtyId) => {
      const test = await subscribe({ ordered: true })
      test.replaceTarget(samePtyId)
      test.input(1, 'stale prefix')
      test.input(2, '\r')
      await vi.waitFor(() => expect(test.receipts()).toHaveLength(2))
      expect(test.receipts()).toEqual([
        expect.objectContaining({ sequence: 1, outcome: 'rejected' }),
        expect.objectContaining({ sequence: 2, outcome: 'rejected' })
      ])
      expect(test.sendTerminal).not.toHaveBeenCalled()
      test.close()
      await test.finished
    }
  )

  it('echoes negotiated limits and acknowledges raw input separately from output/layout sequence', async () => {
    const test = await subscribe({ ordered: true })
    expect(test.subscribed.capabilities.orderedInput).toEqual(TERMINAL_ORDERED_INPUT_CAPABILITY)
    test.input(1, 'é\u0000\u001b[A\r')
    await vi.waitFor(() => expect(test.receipts()).toEqual([{ sequence: 1, outcome: 'accepted' }]))
    expect(test.sendTerminal.mock.calls[0][1].text).toBe('é\u0000\u001b[A\r')
    test.close()
    await test.finished
  })

  it.each([{ ordered: false }, { ordered: true, mobile: false }])(
    'does not opt an unsupported peer into receipts: %j',
    async (options) => {
      const test = await subscribe(options)
      expect(test.subscribed.capabilities?.orderedInput).toBeUndefined()
      test.input(0, 'legacy')
      await vi.waitFor(() => expect(test.sendTerminal).toHaveBeenCalledOnce())
      expect(test.receipts()).toEqual([])
      test.close()
      await test.finished
    }
  )

  it.each(['before', 'after'] as const)(
    'distinguishes %s-write failure and suppresses pipelined Enter',
    async (fail) => {
      const test = await subscribe({ ordered: true, fail })
      test.input(1, 'text')
      test.input(2, '\r')
      await vi.waitFor(() => expect(test.receipts()).toHaveLength(2))
      expect(test.receipts()[0]).toMatchObject({
        sequence: 1,
        outcome: fail === 'before' ? 'rejected' : 'unknown'
      })
      expect(test.receipts()[1]).toMatchObject({ sequence: 2, reason: 'dependency_failed' })
      expect(test.sendTerminal).toHaveBeenCalledOnce()
      test.close()
      await test.finished
    }
  )

  it('ends the subscription when a receipt cannot be sent', async () => {
    const test = await subscribe({ ordered: true })
    test.rejectBinary()
    test.input(1, 'text')
    await test.finished
    expect(test.handlers.size).toBe(0)
    expect(test.receipts()).toEqual([])
  })
})
