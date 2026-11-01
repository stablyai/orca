import './unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson
} from '../../../shared/terminal-stream-protocol'
import {
  TERMINAL_MULTIPLEX_MAX_PENDING_PTY_WAITS_PER_CONNECTION,
  TERMINAL_MULTIPLEX_MAX_QUEUED_PTY_WAITS_PER_CONNECTION
} from '../../../shared/terminal-multiplex-flow-control'

import { startDesktopMultiplexSubscribe } from './terminal-multiplex-test-harness'

function startPendingPtyHarness() {
  const waits = new Map<string, { signal: AbortSignal; resolve: (ptyId: string) => void }>()
  const ptyIds = new Map<string, string>()
  const requestRendererTerminalTabMount = vi.fn()
  const harness = startDesktopMultiplexSubscribe({
    resolveLiveLeafForHandle: vi.fn((handle: string) => ({ ptyId: ptyIds.get(handle) ?? null })),
    requestRendererTerminalTabMount,
    waitForLeafPtyId: vi.fn(
      (handle: string, _timeoutMs?: number, signal?: AbortSignal) =>
        new Promise<string>((resolve, reject) => {
          if (signal) {
            waits.set(handle, {
              signal,
              resolve: (ptyId) => {
                ptyIds.set(handle, ptyId)
                resolve(ptyId)
              }
            })
          }
          signal?.addEventListener('abort', () => reject(new Error('request_aborted')), {
            once: true
          })
        })
    )
  })
  const send = (opcode: TerminalStreamOpcode, streamId: number, terminal?: string): void => {
    const subscribe = opcode === TerminalStreamOpcode.Subscribe
    harness.handlers.get(subscribe ? 0 : streamId)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode,
          streamId: subscribe ? 0 : streamId,
          seq: streamId,
          payload: subscribe
            ? encodeTerminalStreamJson({
                streamId,
                terminal,
                client: { id: 'desktop-1', type: 'desktop' },
                capabilities: { ackOutput: 1 }
              })
            : new Uint8Array()
        })
      )!
    )
  }
  const results = (): { type?: string; streamId?: number; message?: string }[] =>
    harness.messages.map((message) => JSON.parse(message).result)
  return { harness, waits, requestRendererTerminalTabMount, send, results }
}

describe('terminal multiplex PTY wait queue', () => {
  it('rejects only past the queue bound and admits queued waits in order', async () => {
    const { harness, waits, requestRendererTerminalTabMount, send, results } =
      startPendingPtyHarness()
    await vi.waitFor(() => expect(results().some((r) => r?.type === 'ready')).toBe(true))
    const total =
      TERMINAL_MULTIPLEX_MAX_PENDING_PTY_WAITS_PER_CONNECTION +
      TERMINAL_MULTIPLEX_MAX_QUEUED_PTY_WAITS_PER_CONNECTION
    for (let streamId = 1; streamId <= total + 1; streamId += 1) {
      send(TerminalStreamOpcode.Subscribe, streamId, `pane-${streamId}`)
    }
    await vi.waitFor(() =>
      expect(results()).toContainEqual({
        type: 'error',
        streamId: total + 1,
        message: 'terminal_stream_limit_exceeded'
      })
    )
    expect(
      results().filter((r) => r?.type === 'error' && r.message === 'terminal_stream_limit_exceeded')
    ).toHaveLength(1)
    await vi.waitFor(() =>
      expect(waits.size).toBe(TERMINAL_MULTIPLEX_MAX_PENDING_PTY_WAITS_PER_CONNECTION)
    )
    // Mount only during paced admission, not when subscribe queues the pane.
    expect(requestRendererTerminalTabMount).toHaveBeenCalledTimes(
      TERMINAL_MULTIPLEX_MAX_PENDING_PTY_WAITS_PER_CONNECTION
    )

    waits.get('pane-1')?.resolve('pty-1')
    const next = `pane-${TERMINAL_MULTIPLEX_MAX_PENDING_PTY_WAITS_PER_CONNECTION + 1}`
    await vi.waitFor(() => expect(waits.has(next)).toBe(true))
    await vi.waitFor(() =>
      expect(results()).toContainEqual(expect.objectContaining({ type: 'subscribed', streamId: 1 }))
    )

    harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
    await vi.waitFor(() => expect(waits.get(next)?.signal.aborted).toBe(true))
    await harness.dispatchPromise
  })

  it('drops a queued wait on unsubscribe without spending a running slot', async () => {
    const { harness, waits, send, results } = startPendingPtyHarness()
    await vi.waitFor(() => expect(results().some((r) => r?.type === 'ready')).toBe(true))
    const cap = TERMINAL_MULTIPLEX_MAX_PENDING_PTY_WAITS_PER_CONNECTION
    for (let streamId = 1; streamId <= cap + 2; streamId += 1) {
      send(TerminalStreamOpcode.Subscribe, streamId, `pane-${streamId}`)
    }
    await vi.waitFor(() => expect(waits.size).toBe(cap))
    send(TerminalStreamOpcode.Unsubscribe, cap + 1)
    waits.get('pane-1')?.resolve('pty-1')

    await vi.waitFor(() => expect(waits.has(`pane-${cap + 2}`)).toBe(true))
    expect(waits.has(`pane-${cap + 1}`)).toBe(false)

    harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
    await harness.dispatchPromise
  })
})
