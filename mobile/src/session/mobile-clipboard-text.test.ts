import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcFailure, RpcResponse, RpcSuccess } from '../transport/types'
import {
  assertMobileClipboardTextWithinLimit,
  MOBILE_CLIPBOARD_TEXT_MAX_BYTES,
  readHostClipboardText,
  sanitizeTerminalPasteText,
  writeHostClipboardText
} from './mobile-clipboard-text'

function ok(id: string, result: unknown): RpcSuccess {
  return { id, ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

function fail(id: string, code: string, message: string): RpcFailure {
  return { id, ok: false, error: { code, message }, _meta: { runtimeId: 'runtime-1' } }
}

function clientWithResponses(responses: RpcResponse[]): Pick<RpcClient, 'sendRequest'> & {
  calls: Array<{ method: string; params: unknown }>
} {
  const calls: Array<{ method: string; params: unknown }> = []
  return {
    calls,
    sendRequest: vi.fn(async (method: string, params?: unknown) => {
      calls.push({ method, params })
      const response = responses.shift()
      if (!response) {
        throw new Error(`unexpected request: ${method}`)
      }
      return response
    })
  }
}

describe('mobile clipboard text helpers', () => {
  it('strips embedded bracketed-paste markers only when wrapping', () => {
    const text = 'before\u001b[200~inside\u001b[201~after'

    expect(sanitizeTerminalPasteText(text, true)).toBe('beforeinsideafter')
    expect(sanitizeTerminalPasteText(text, false)).toBe(text)
  })

  it('accepts small clipboard text and rejects oversized text', () => {
    expect(() => assertMobileClipboardTextWithinLimit('small')).not.toThrow()
    expect(() =>
      assertMobileClipboardTextWithinLimit('a'.repeat(MOBILE_CLIPBOARD_TEXT_MAX_BYTES + 1))
    ).toThrow('Clipboard text is too large')
  })

  it('reads host clipboard text through RPC', async () => {
    const client = clientWithResponses([ok('read', { available: true, text: 'from desktop' })])

    await expect(readHostClipboardText(client)).resolves.toBe('from desktop')

    expect(client.calls).toEqual([{ method: 'clipboard.readText', params: null }])
  })

  it('returns an empty string for an unavailable host clipboard', async () => {
    const client = clientWithResponses([ok('read', { available: false, text: '' })])

    await expect(readHostClipboardText(client)).resolves.toBe('')
  })

  it('throws a useful error when host clipboard read fails', async () => {
    const client = clientWithResponses([fail('read', 'runtime_error', 'desktop denied clipboard')])

    await expect(readHostClipboardText(client)).rejects.toThrow('desktop denied clipboard')
  })

  it('writes phone clipboard text through RPC', async () => {
    const client = clientWithResponses([ok('write', { written: true })])

    await expect(writeHostClipboardText(client, 'from phone')).resolves.toBeUndefined()

    expect(client.calls).toEqual([
      { method: 'clipboard.writeText', params: { text: 'from phone' } }
    ])
  })

  it('throws a useful error when host clipboard write fails', async () => {
    const client = clientWithResponses([fail('write', 'runtime_error', 'desktop denied clipboard')])

    await expect(writeHostClipboardText(client, 'from phone')).rejects.toThrow(
      'desktop denied clipboard'
    )
  })
})
