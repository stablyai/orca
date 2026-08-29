import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebSocket } from 'ws'
import { handleMockTerminalRequest } from '../../scripts/mock-server-terminal-stream'
import {
  handleRequest,
  type RpcRequest,
  type RpcRespond,
  type RpcResponse
} from '../../scripts/mock-server-rpc-handlers'

type DeferredResponse = {
  response: RpcResponse
  shouldSend?: () => boolean
}

function success(id: string, result: unknown, streaming?: boolean): RpcResponse {
  return {
    id,
    ok: true,
    result,
    ...(streaming ? { streaming: true as const } : {}),
    _meta: { runtimeId: 'test' }
  }
}

function request(id: string, method: string): RpcRequest {
  return { id, method, params: { terminal: 'term-1', viewport: { cols: 80, rows: 24 } } }
}

describe('mock terminal stream cancellation', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('invalidates delayed frames after resubscribe and unsubscribe', () => {
    vi.useFakeTimers()
    const ws = { OPEN: 1, readyState: 1 } as unknown as WebSocket
    const deferred: DeferredResponse[] = []
    const respond: RpcRespond = (response, shouldSend) => {
      deferred.push({ response, shouldSend })
    }
    const handle = (rpcRequest: RpcRequest) =>
      handleMockTerminalRequest(rpcRequest, respond, success, ws, () => 'wt')

    expect(handle(request('old', 'terminal.subscribe'))).toBe(true)
    vi.advanceTimersByTime(500)
    expect(deferred.filter(({ response }) => response.id === 'old')).toHaveLength(2)

    expect(handle(request('new', 'terminal.subscribe'))).toBe(true)
    const oldResponses = deferred.filter(({ response }) => response.id === 'old')
    const newResponses = deferred.filter(({ response }) => response.id === 'new')
    expect(oldResponses.every(({ shouldSend }) => shouldSend?.() === false)).toBe(true)
    expect(newResponses.every(({ shouldSend }) => shouldSend?.() === true)).toBe(true)

    expect(handle(request('stop', 'terminal.unsubscribe'))).toBe(true)
    expect(newResponses.every(({ shouldSend }) => shouldSend?.() === false)).toBe(true)
  })

  it('drops queued delayed frames after stream cancellation', () => {
    vi.useFakeTimers()
    vi.stubEnv('MOCK_RPC_DELAY_TERMINAL_SUBSCRIBE_MS', '1000')
    const ws = { OPEN: 1, readyState: 1 } as unknown as WebSocket
    const send = vi.fn<(response: RpcResponse) => void>()

    handleRequest(request('old', 'terminal.subscribe'), send, ws)
    vi.advanceTimersByTime(500)
    handleRequest(request('new', 'terminal.subscribe'), send, ws)
    handleRequest(request('stop', 'terminal.unsubscribe'), send, ws)

    vi.advanceTimersByTime(1000)
    expect(send.mock.calls.map(([response]) => response.id)).toEqual(['stop'])
  })
})
