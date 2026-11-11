import { describe, expect, it, vi } from 'vitest'
import './dispatcher'
import './methods/terminal/terminal'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson
} from '../../../shared/terminal/stream/terminal-stream-protocol'
import {
  TERMINAL_MULTIPLEX_MAX_ACTIVE_STREAMS_PER_CONNECTION,
  TERMINAL_MULTIPLEX_MAX_PENDING_PTY_WAITS_PER_CONNECTION
} from '../../../shared/terminal/stream/terminal-multiplex-flow-control'
import {
  sendDesktopMultiplexSubscribe,
  startDesktopMultiplexSubscribe,
  stubRuntime
} from './terminal-multiplex-test-harness'

describe('terminal multiplex RPC', () => {
  it('cancels a pending desktop PTY wait when its multiplex slot unsubscribes', async () => {
    let resolvePty: (ptyId: string) => void = () => {}
    let waitSignal: AbortSignal | undefined
    const readTerminal = vi.fn().mockResolvedValue({ tail: [], truncated: false })
    const subscribeToTerminalData = vi.fn().mockReturnValue(vi.fn())
    const registerRemoteTerminalViewSubscriber = vi.fn().mockReturnValue(vi.fn())
    const waitForLeafPtyId = vi.fn(
      (_handle: string, _timeoutMs?: number, signal?: AbortSignal) =>
        new Promise<string>((resolve, reject) => {
          resolvePty = resolve
          waitSignal = signal
          signal?.addEventListener('abort', () => reject(new Error('request_aborted')), {
            once: true
          })
        })
    )
    const harness = startDesktopMultiplexSubscribe({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: null }),
      waitForLeafPtyId,
      readTerminal,
      subscribeToTerminalData,
      registerRemoteTerminalViewSubscriber
    })
    await vi.waitFor(() =>
      expect(harness.messages.some((msg) => JSON.parse(msg).result?.type === 'ready')).toBe(true)
    )
    sendDesktopMultiplexSubscribe(harness.handlers)
    await vi.waitFor(() => expect(waitForLeafPtyId).toHaveBeenCalled())

    harness.handlers.get(7)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Unsubscribe,
          streamId: 7,
          seq: 2,
          payload: new Uint8Array()
        })
      )!
    )
    resolvePty('pty-1')

    await vi.waitFor(() =>
      expect(waitSignal?.aborted || readTerminal.mock.calls.length > 0).toBe(true)
    )
    // Closed panes must not become hidden output consumers when their late PTY appears.
    expect(waitSignal?.aborted).toBe(true)
    expect(readTerminal).not.toHaveBeenCalled()
    expect(subscribeToTerminalData).not.toHaveBeenCalled()
    expect(registerRemoteTerminalViewSubscriber).not.toHaveBeenCalled()
    expect(harness.handlers.has(7)).toBe(false)

    harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
    await harness.dispatchPromise
  })

  it('admits 128 active streams, rejects the 129th, and reuses released capacity', async () => {
    let dataSubscriberCount = 0
    let viewSubscriberCount = 0
    const harness = startDesktopMultiplexSubscribe({
      subscribeToTerminalData: vi.fn(() => {
        dataSubscriberCount += 1
        let released = false
        return () => {
          if (!released) {
            released = true
            dataSubscriberCount -= 1
          }
        }
      }),
      registerRemoteTerminalViewSubscriber: vi.fn(() => {
        viewSubscriberCount += 1
        let released = false
        return () => {
          if (!released) {
            released = true
            viewSubscriberCount -= 1
          }
        }
      })
    })
    await vi.waitFor(() =>
      expect(harness.messages.some((message) => JSON.parse(message).result?.type === 'ready')).toBe(
        true
      )
    )
    const sendSubscribe = (streamId: number): void => {
      harness.handlers.get(0)?.(
        decodeTerminalStreamFrame(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.Subscribe,
            streamId: 0,
            seq: streamId,
            payload: encodeTerminalStreamJson({
              streamId,
              terminal: 'terminal-1',
              client: { id: 'desktop-1', type: 'desktop' },
              capabilities: { ackOutput: 1 }
            })
          })
        )!
      )
    }
    for (
      let streamId = 1;
      streamId <= TERMINAL_MULTIPLEX_MAX_ACTIVE_STREAMS_PER_CONNECTION + 1;
      streamId += 1
    ) {
      sendSubscribe(streamId)
    }

    await vi.waitFor(() => {
      const results = harness.messages.map((message) => JSON.parse(message).result)
      const subscribedStreamIds = results
        .filter((result) => result?.type === 'subscribed')
        .map((result) => result.streamId)
      expect(subscribedStreamIds).toHaveLength(TERMINAL_MULTIPLEX_MAX_ACTIVE_STREAMS_PER_CONNECTION)
      expect(subscribedStreamIds).toContain(44)
      expect(results).toContainEqual({
        type: 'error',
        streamId: TERMINAL_MULTIPLEX_MAX_ACTIVE_STREAMS_PER_CONNECTION + 1,
        message: 'terminal_stream_limit_exceeded'
      })
      expect(results).toContainEqual({
        type: 'end',
        streamId: TERMINAL_MULTIPLEX_MAX_ACTIVE_STREAMS_PER_CONNECTION + 1
      })
    })
    expect(dataSubscriberCount).toBe(TERMINAL_MULTIPLEX_MAX_ACTIVE_STREAMS_PER_CONNECTION)
    expect(viewSubscriberCount).toBe(TERMINAL_MULTIPLEX_MAX_ACTIVE_STREAMS_PER_CONNECTION)

    harness.handlers.get(1)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Unsubscribe,
          streamId: 1,
          seq: TERMINAL_MULTIPLEX_MAX_ACTIVE_STREAMS_PER_CONNECTION + 2,
          payload: new Uint8Array()
        })
      )!
    )
    await vi.waitFor(() => {
      expect(dataSubscriberCount).toBe(TERMINAL_MULTIPLEX_MAX_ACTIVE_STREAMS_PER_CONNECTION - 1)
      expect(viewSubscriberCount).toBe(TERMINAL_MULTIPLEX_MAX_ACTIVE_STREAMS_PER_CONNECTION - 1)
      expect(harness.handlers.has(1)).toBe(false)
    })

    const retriedStreamId = TERMINAL_MULTIPLEX_MAX_ACTIVE_STREAMS_PER_CONNECTION + 1
    sendSubscribe(retriedStreamId)
    await vi.waitFor(() => {
      const subscribedStreamIds = harness.messages
        .map((message) => JSON.parse(message).result)
        .filter((result) => result?.type === 'subscribed')
        .map((result) => result.streamId)
      expect(subscribedStreamIds).toContain(retriedStreamId)
      expect(
        harness.binaryFrames.some((bytes) => {
          const frame = decodeTerminalStreamFrame(bytes)
          return (
            frame?.streamId === retriedStreamId && frame.opcode === TerminalStreamOpcode.SnapshotEnd
          )
        })
      ).toBe(true)
    })
    expect(dataSubscriberCount).toBe(TERMINAL_MULTIPLEX_MAX_ACTIVE_STREAMS_PER_CONNECTION)
    expect(viewSubscriberCount).toBe(TERMINAL_MULTIPLEX_MAX_ACTIVE_STREAMS_PER_CONNECTION)

    harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
    await harness.dispatchPromise
    expect(dataSubscriberCount).toBe(0)
    expect(viewSubscriberCount).toBe(0)
  })

  it('queues PTY waits past the running cap independently from active streams', async () => {
    const activeStreamCount = 44
    const waitSignals: AbortSignal[] = []
    const resolveWaits: ((ptyId: string) => void)[] = []
    const ptyIds = new Map<string, string>()
    const runtime = stubRuntime({
      resolveLiveLeafForHandle: vi.fn((terminal: string) =>
        terminal.startsWith('pending-')
          ? { ptyId: ptyIds.get(terminal) ?? null }
          : { ptyId: `pty-${terminal}` }
      ),
      waitForLeafPtyId: vi.fn(
        (handle: string, _timeoutMs?: number, signal?: AbortSignal) =>
          new Promise<string>((resolve, reject) => {
            if (signal) {
              waitSignals.push(signal)
            }
            resolveWaits.push((ptyId) => {
              ptyIds.set(handle, ptyId)
              resolve(ptyId)
            })
            signal?.addEventListener('abort', () => reject(new Error('request_aborted')), {
              once: true
            })
          })
      )
    })
    const harness = startDesktopMultiplexSubscribe(runtime)
    await vi.waitFor(() =>
      expect(harness.messages.some((message) => JSON.parse(message).result?.type === 'ready')).toBe(
        true
      )
    )
    const sendSubscribe = (streamId: number, terminal: string): void => {
      harness.handlers.get(0)?.(
        decodeTerminalStreamFrame(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.Subscribe,
            streamId: 0,
            seq: streamId,
            payload: encodeTerminalStreamJson({
              streamId,
              terminal,
              client: { id: 'desktop-1', type: 'desktop' },
              capabilities: { ackOutput: 1 }
            })
          })
        )!
      )
    }

    for (let streamId = 1; streamId <= activeStreamCount; streamId += 1) {
      sendSubscribe(streamId, `active-${streamId}`)
    }
    await vi.waitFor(() =>
      expect(
        harness.messages.filter((message) => JSON.parse(message).result?.type === 'subscribed')
      ).toHaveLength(activeStreamCount)
    )

    for (
      let offset = 1;
      offset <= TERMINAL_MULTIPLEX_MAX_PENDING_PTY_WAITS_PER_CONNECTION + 1;
      offset += 1
    ) {
      sendSubscribe(activeStreamCount + offset, `pending-${offset}`)
    }
    await vi.waitFor(() =>
      expect(waitSignals).toHaveLength(TERMINAL_MULTIPLEX_MAX_PENDING_PTY_WAITS_PER_CONNECTION)
    )
    // Queue beyond the running cap instead of failing restore (STA-2886).
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(waitSignals).toHaveLength(TERMINAL_MULTIPLEX_MAX_PENDING_PTY_WAITS_PER_CONNECTION)

    resolveWaits[0]?.('pty-pending-1')
    await vi.waitFor(() =>
      expect(waitSignals).toHaveLength(TERMINAL_MULTIPLEX_MAX_PENDING_PTY_WAITS_PER_CONNECTION + 1)
    )
    for (const [index, resolve] of resolveWaits.entries()) {
      resolve(`pty-pending-${index + 1}`)
    }
    await vi.waitFor(() => {
      const results = harness.messages.map((message) => JSON.parse(message).result)
      expect(results.filter((result) => result?.type === 'subscribed')).toHaveLength(
        activeStreamCount + TERMINAL_MULTIPLEX_MAX_PENDING_PTY_WAITS_PER_CONNECTION + 1
      )
      expect(
        results.filter(
          (result) =>
            result?.type === 'error' && result.message === 'terminal_stream_limit_exceeded'
        )
      ).toHaveLength(0)
    })

    harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
    await harness.dispatchPromise
  })
})
