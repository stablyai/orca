import { describe, expect, it } from 'vitest'
import { isRpcResponse } from './rpc-response-shape'

describe('isRpcResponse', () => {
  it('requires success responses to include a result field', () => {
    expect(isRpcResponse({ id: 'rpc-1', ok: true, result: null })).toBe(true)
    expect(isRpcResponse({ id: 'rpc-1', ok: true })).toBe(false)
  })

  it('requires failure responses to include code and message', () => {
    expect(
      isRpcResponse({
        id: 'rpc-1',
        ok: false,
        error: { code: 'failed', message: 'Nope' }
      })
    ).toBe(true)
    expect(isRpcResponse({ id: 'rpc-1', ok: false, error: { code: 'failed' } })).toBe(false)
  })

  it('accepts additive future fields without weakening known-field validation', () => {
    expect(
      isRpcResponse({
        id: 'rpc-1',
        ok: true,
        result: { value: 1 },
        futureEnvelopeField: true
      })
    ).toBe(true)
    expect(
      isRpcResponse({
        id: 'rpc-1',
        ok: false,
        error: { code: 500, message: 'Nope', futureErrorField: true },
        futureEnvelopeField: true
      })
    ).toBe(false)
  })
})
