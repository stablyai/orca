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
    expect(isRendererUnavailableRefusal(failure('renderer_unavailable', ''))).toBe(true)
  })

  it('rejects successes, other refusals, and malformed refusals', () => {
    expect(isRendererUnavailableRefusal({ id: 'request-1', ok: true, result: null })).toBe(false)
    expect(isRendererUnavailableRefusal(failure('runtime_error', 'renderer_timeout'))).toBe(false)
    expect(isRendererUnavailableRefusal(failure('forbidden', 'renderer_unavailable'))).toBe(false)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: models an unvalidated wire reply missing its error.
    expect(isRendererUnavailableRefusal({ id: 'request-1', ok: false } as RpcResponse)).toBe(false)
  })

  it('matches exactly, never a neighbouring failure or a substring', () => {
    const neighbours: [string, string][] = [
      ['runtime_unavailable', 'runtime_unavailable'],
      ['runtime_error', 'runtime_unavailable'],
      ['browser_client_page_renderer_unavailable', 'renderer_unavailable'],
      ['runtime_error', 'browser_client_page_renderer_unavailable'],
      ['runtime_error', 'renderer_unavailable: window closed'],
      ['runtime_error', ' renderer_unavailable'],
      ['runtime_error', 'RENDERER_UNAVAILABLE'],
      ['renderer_unavailable_v2', 'renderer_unavailable'],
      ['timeout', 'Request timed out'],
      ['liveness-timeout', 'renderer_unavailable'],
      ['socket-closed', 'renderer_unavailable'],
      ['unavailable', 'renderer_unavailable'],
      // A host whose window is still taking over editor tabs: retryable, never a device fallback.
      ['runtime_error', "The computer's Orca window is still starting. Try again."]
    ]
    for (const [code, message] of neighbours) {
      expect(isRendererUnavailableRefusal(failure(code, message)), `${code}/${message}`).toBe(false)
    }
  })
})
