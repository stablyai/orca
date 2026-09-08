// src/relay/agent-rpc-dispatch-browser.test.ts
// Why mock ./browser-handler (not agent-browser's CLI itself): this suite
// verifies dispatchBrowserRpc's own contract — which method routes to which
// handler, and that an unknown method falls through to `null` — not the
// handlers' own arg-construction/error-mapping behavior (covered by
// browser-handler.test.ts).
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createWireState } from 'orca-dev-agent-transport'
import type { AgentLogger } from './agent-logger'
import type { JsonRpcRequest } from './agent-rpc-dispatch'
import type WebSocket from 'ws'

const handleBrowserProfileClearDefaultCookies = vi.fn()
const handleBrowserProfileDetectBrowsers = vi.fn()

vi.mock('./browser-handler', () => ({
  handleBrowserProfileClearDefaultCookies: (...args: unknown[]) =>
    handleBrowserProfileClearDefaultCookies(...args),
  handleBrowserProfileDetectBrowsers: (...args: unknown[]) =>
    handleBrowserProfileDetectBrowsers(...args)
}))

class MockWs {
  readyState = 1
  send = vi.fn()
}

const LOG: AgentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn()
}

beforeEach(() => {
  handleBrowserProfileClearDefaultCookies.mockReset()
  handleBrowserProfileDetectBrowsers.mockReset()
})

describe('dispatchBrowserRpc — browser.profileClearDefaultCookies', () => {
  it('routes to handleBrowserProfileClearDefaultCookies and returns its response', async () => {
    const { dispatchBrowserRpc } = await import('./agent-rpc-dispatch-browser')
    const expected = { jsonrpc: '2.0' as const, id: 1, result: { cleared: true } }
    handleBrowserProfileClearDefaultCookies.mockResolvedValue(expected)

    const rpc: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'browser.profileClearDefaultCookies'
    }
    const response = await dispatchBrowserRpc(
      rpc,
      LOG,
      new MockWs() as unknown as WebSocket,
      createWireState()
    )

    expect(handleBrowserProfileClearDefaultCookies).toHaveBeenCalledWith(1, {}, LOG)
    expect(response).toEqual(expected)
  })

  it('maps a thrown handler-import/call failure to a ServerError response', async () => {
    const { dispatchBrowserRpc } = await import('./agent-rpc-dispatch-browser')
    handleBrowserProfileClearDefaultCookies.mockRejectedValue(new Error('boom'))

    const rpc: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 2,
      method: 'browser.profileClearDefaultCookies'
    }
    const response = await dispatchBrowserRpc(
      rpc,
      LOG,
      new MockWs() as unknown as WebSocket,
      createWireState()
    )

    expect(response).toMatchObject({
      error: { message: expect.stringContaining('browser.profileClearDefaultCookies unavailable') }
    })
  })

  it('no longer falls through to the default null case', async () => {
    const { dispatchBrowserRpc } = await import('./agent-rpc-dispatch-browser')
    handleBrowserProfileClearDefaultCookies.mockResolvedValue({
      jsonrpc: '2.0',
      id: 3,
      result: { cleared: true }
    })

    const rpc: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 3,
      method: 'browser.profileClearDefaultCookies'
    }
    const response = await dispatchBrowserRpc(
      rpc,
      LOG,
      new MockWs() as unknown as WebSocket,
      createWireState()
    )

    expect(response).not.toBeNull()
  })
})

describe('dispatchBrowserRpc — browser.profileDetectBrowsers', () => {
  it('routes to handleBrowserProfileDetectBrowsers and returns its response', async () => {
    const { dispatchBrowserRpc } = await import('./agent-rpc-dispatch-browser')
    const expected = { jsonrpc: '2.0' as const, id: 10, result: { browsers: [] } }
    handleBrowserProfileDetectBrowsers.mockResolvedValue(expected)

    const rpc: JsonRpcRequest = { jsonrpc: '2.0', id: 10, method: 'browser.profileDetectBrowsers' }
    const response = await dispatchBrowserRpc(
      rpc,
      LOG,
      new MockWs() as unknown as WebSocket,
      createWireState()
    )

    expect(handleBrowserProfileDetectBrowsers).toHaveBeenCalledWith(10, {}, LOG)
    expect(response).toEqual(expected)
  })

  it('maps a thrown handler failure to a ServerError response', async () => {
    const { dispatchBrowserRpc } = await import('./agent-rpc-dispatch-browser')
    handleBrowserProfileDetectBrowsers.mockRejectedValue(new Error('boom'))

    const rpc: JsonRpcRequest = { jsonrpc: '2.0', id: 11, method: 'browser.profileDetectBrowsers' }
    const response = await dispatchBrowserRpc(
      rpc,
      LOG,
      new MockWs() as unknown as WebSocket,
      createWireState()
    )

    expect(response).toMatchObject({
      error: { message: expect.stringContaining('browser.profileDetectBrowsers unavailable') }
    })
  })
})

describe('dispatchBrowserRpc — unrecognized method', () => {
  it('returns null for a method with no case', async () => {
    const { dispatchBrowserRpc } = await import('./agent-rpc-dispatch-browser')
    const rpc: JsonRpcRequest = { jsonrpc: '2.0', id: 4, method: 'browser.notARealMethod' }
    const response = await dispatchBrowserRpc(
      rpc,
      LOG,
      new MockWs() as unknown as WebSocket,
      createWireState()
    )
    expect(response).toBeNull()
  })
})
