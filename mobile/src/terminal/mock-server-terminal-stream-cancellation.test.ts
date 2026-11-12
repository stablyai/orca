import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebSocket } from 'ws'
import {
  handleRequest,
  type RpcRequest,
  type RpcResponse
} from '../../scripts/mock-server-rpc-handlers'

function request(id: string, method: string): RpcRequest {
  return { id, method, params: { terminal: 'term-1', viewport: { cols: 80, rows: 24 } } }
}

describe('mock terminal stream cancellation', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
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
