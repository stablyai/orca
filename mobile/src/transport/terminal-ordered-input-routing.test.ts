import { describe, expect, it, vi } from 'vitest'
import { RpcClientStreamRegistry } from './rpc-client-stream-registry'
import { MobileRelayRpcStreams } from './mobile-relay-rpc-streams'
import { encodeTerminalStreamFrame, TerminalStreamOpcode } from './terminal-stream-protocol'
import { TERMINAL_ORDERED_INPUT_CAPABILITY } from '../../../src/shared/terminal-ordered-input'
import type { RpcResponse } from './types'

describe.each(['direct', 'relay'] as const)('%s ordered input routing', (path) => {
  function setup() {
    const sent: { id: string; params?: unknown }[] = []
    const send = (request: unknown) => {
      sent.push(request as { id: string; params?: unknown })
      return true
    }
    const binary = vi.fn((_bytes: Uint8Array) => true)
    let next = 0
    const options = { nextId: () => `${++next}`, sendBinary: binary }
    const registry =
      path === 'direct'
        ? new RpcClientStreamRegistry({
            ...options,
            deviceToken: 'device',
            getState: () => 'connected',
            sendEncrypted: send
          })
        : new MobileRelayRpcStreams({
            ...options,
            sendFrame: send,
            waitForConnected: async () => {}
          })
    return { registry, sent, binary }
  }

  it('advertises, routes receipts, and cancels pending input when unsubscribed', async () => {
    const { registry, sent, binary } = setup()
    const dispose = registry.subscribe('terminal.subscribe', { terminal: 't' }, vi.fn())
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]?.params).toMatchObject({ capabilities: { orderedInput: 1 } })
    const response: RpcResponse = {
      id: sent[0]!.id,
      ok: true,
      streaming: true,
      result: {
        type: 'subscribed',
        streamId: 7,
        capabilities: { orderedInput: TERMINAL_ORDERED_INPUT_CAPABILITY }
      },
      _meta: { runtimeId: 'r' }
    }
    registry.handleResponse(response)
    expect(registry.supportsTerminalStreamInput('t')).toBe(true)
    const first = registry.sendTerminalStreamInput('t', 'a')!
    expect(binary).toHaveBeenCalledOnce()
    registry.handleBinary(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Metadata,
        streamId: 7,
        seq: 999,
        payload: new TextEncoder().encode(
          JSON.stringify({ inputReceipt: { sequence: 1, outcome: 'accepted' } })
        )
      })
    )
    expect(await first).toBe(true)
    const second = registry.sendTerminalStreamInput('t', 'b')!
    registry.cancelTerminalStreamInput('t')
    expect(sent).toContainEqual(expect.objectContaining({ method: 'terminal.unsubscribe' }))
    dispose()
    expect(await second).toBe(false)
    expect(registry.getTerminalStreamInputFailure('t')).toEqual({
      outcome: 'unknown',
      reason: 'cancelled'
    })
    expect(registry.supportsTerminalStreamInput('t')).toBe(true)
    expect(await registry.sendTerminalStreamInput('t', '\r')).toBe(false)
  })

  it.each([
    undefined,
    { orderedInput: { ...TERMINAL_ORDERED_INPUT_CAPABILITY, version: 2 } },
    { orderedInput: { ...TERMINAL_ORDERED_INPUT_CAPABILITY, maxPendingFrames: 0 } }
  ])('preserves fallback for an unsupported host echo: %j', async (capabilities) => {
    const { registry, sent, binary } = setup()
    const dispose = registry.subscribe('terminal.subscribe', { terminal: 't' }, vi.fn())
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    registry.handleResponse({
      id: sent[0]!.id,
      ok: true,
      streaming: true,
      result: { type: 'subscribed', streamId: 7, capabilities },
      _meta: { runtimeId: 'r' }
    })
    expect(registry.sendTerminalStreamInput('t', 'a')).toBe(null)
    expect(registry.supportsTerminalStreamInput('t')).toBe(false)
    expect(binary).not.toHaveBeenCalled()
    dispose()
  })

  it('settles admitted input on physical connection loss', async () => {
    const { registry, sent, binary } = setup()
    registry.subscribe('terminal.subscribe', { terminal: 't' }, vi.fn())
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    registry.handleResponse({
      id: sent[0]!.id,
      ok: true,
      streaming: true,
      result: {
        type: 'subscribed',
        streamId: 7,
        capabilities: { orderedInput: TERMINAL_ORDERED_INPUT_CAPABILITY }
      },
      _meta: { runtimeId: 'r' }
    })
    const input = registry.sendTerminalStreamInput('t', 'a')!
    if (registry instanceof RpcClientStreamRegistry) {
      registry.markForReplay()
    } else {
      registry.clear()
    }
    expect(await input).toBe(false)
    expect(registry.supportsTerminalStreamInput('t')).toBe(true)
    expect(await registry.sendTerminalStreamInput('t', '\r')).toBe(false)
    const subscribed = vi.fn()
    const dispose = registry.subscribe('terminal.subscribe', { terminal: 't' }, subscribed)
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    registry.handleResponse({
      id: sent[1]!.id,
      ok: true,
      streaming: true,
      result: { type: 'subscribed', streamId: 9 },
      _meta: { runtimeId: 'older-host' }
    })
    expect(subscribed.mock.calls[0]?.[0]).toMatchObject({ type: 'subscribed', streamId: 9 })
    expect(registry.supportsTerminalStreamInput('t')).toBe(true)
    expect(await registry.sendTerminalStreamInput('t', '\r')).toBe(false)
    expect(registry.recoverTerminalStreamInput('t')).toBe(false)
    expect(binary).toHaveBeenCalledOnce()
    dispose()
  })
})
