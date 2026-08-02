import { describe, expect, it } from 'vitest'
import type { RpcResponse } from '../transport/types'
import { isTerminalSendRpcAccepted } from './terminal-send-rpc-response'

const runtimeMeta = { runtimeId: 'test-runtime' } as const

describe('terminal send RPC response', () => {
  it('Given accepted terminal send response When checked Then reports success', () => {
    // Given
    const response: RpcResponse = {
      id: '1',
      ok: true,
      result: { send: { handle: 'terminal-1', accepted: true, bytesWritten: 1 } },
      _meta: runtimeMeta
    }

    // When / Then
    expect(isTerminalSendRpcAccepted(response)).toBe(true)
  })

  it('Given rejected terminal send response When checked Then reports failure', () => {
    // Given
    const response: RpcResponse = {
      id: '1',
      ok: true,
      result: { send: { handle: 'terminal-1', accepted: false, bytesWritten: 0 } },
      _meta: runtimeMeta
    }

    // When / Then
    expect(isTerminalSendRpcAccepted(response)).toBe(false)
  })

  it('Given RPC failure or malformed terminal send response When checked Then reports failure', () => {
    // Given
    const rpcFailure: RpcResponse = {
      id: '1',
      ok: false,
      error: { code: 'terminal_error', message: 'failed' },
      _meta: runtimeMeta
    }
    const malformedSuccess: RpcResponse = {
      id: '2',
      ok: true,
      result: {},
      _meta: runtimeMeta
    }

    // When / Then
    expect(isTerminalSendRpcAccepted(rpcFailure)).toBe(false)
    expect(isTerminalSendRpcAccepted(malformedSuccess)).toBe(false)
  })
})
