import { describe, expect, it } from 'vitest'
import type { RpcResponse } from './types'
import { isRendererUnavailableRefusal } from './renderer-unavailable-refusal'

function failure(code: string, message: string): RpcResponse {
  return { id: 'request-1', ok: false, error: { code, message } }
}

describe('isRendererUnavailableRefusal', () => {
  it('recognizes the wrapped runtime_error shape and a passthrough code', () => {
    expect(isRendererUnavailableRefusal(failure('runtime_error', 'renderer_unavailable'))).toBe(
      true
    )
    expect(
      isRendererUnavailableRefusal(failure('renderer_unavailable', 'renderer_unavailable'))
    ).toBe(true)
  })

  it('rejects successes, other refusals, and malformed refusals', () => {
    expect(isRendererUnavailableRefusal({ id: 'request-1', ok: true, result: null })).toBe(false)
    expect(isRendererUnavailableRefusal(failure('runtime_error', 'renderer_timeout'))).toBe(false)
    expect(isRendererUnavailableRefusal(failure('forbidden', 'renderer_unavailable'))).toBe(false)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: models an unvalidated wire reply missing its error.
    expect(isRendererUnavailableRefusal({ id: 'request-1', ok: false } as RpcResponse)).toBe(false)
  })
})
