import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse, RpcSuccess } from '../transport/types'
import { pasteMobileNativeChatImagePaths } from './mobile-native-chat-image-send'

function sendResult(accepted: boolean, id = 'send'): RpcSuccess {
  return { id, ok: true, result: { send: { accepted } }, _meta: { runtimeId: 'r' } }
}

function clientWithResponses(responses: RpcResponse[]): Pick<RpcClient, 'sendRequest'> & {
  calls: { method: string; params: Record<string, unknown> }[]
} {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  return {
    calls,
    sendRequest: vi.fn(async (method: string, params?: unknown) => {
      calls.push({ method, params: params as Record<string, unknown> })
      const response = responses.shift()
      if (!response) {
        throw new Error(`unexpected request: ${method}`)
      }
      return response
    })
  }
}

describe('pasteMobileNativeChatImagePaths', () => {
  it('clears the input line, then pastes each path as a bracketed, non-submitting terminal.send with the mobile client tag', async () => {
    const client = clientWithResponses([sendResult(true), sendResult(true), sendResult(true)])

    const ok = await pasteMobileNativeChatImagePaths({
      client,
      terminal: 'term-1',
      deviceToken: 'device-9',
      imagePaths: ['/tmp/a.png', '/tmp/b.png']
    })

    expect(ok).toBe(true)
    expect(client.calls).toHaveLength(3)
    // Leading Ctrl+U clears any stale input so a retry can't duplicate the image.
    expect(client.calls[0]).toEqual({
      method: 'terminal.send',
      params: {
        terminal: 'term-1',
        text: '\x15',
        enter: false,
        client: { id: 'device-9', type: 'mobile' }
      }
    })
    expect(client.calls[1]?.params.text).toBe('\x1b[200~/tmp/a.png\x1b[201~')
    expect(client.calls[2]?.params.text).toBe('\x1b[200~/tmp/b.png\x1b[201~')
  })

  it('stops and reports failure as soon as a paste is rejected', async () => {
    // Clear accepted, first image paste rejected.
    const client = clientWithResponses([sendResult(true), sendResult(false)])

    const ok = await pasteMobileNativeChatImagePaths({
      client,
      terminal: 'term-1',
      deviceToken: null,
      imagePaths: ['/tmp/a.png', '/tmp/b.png']
    })

    expect(ok).toBe(false)
    // Never attempts the second path after the first is rejected.
    expect(client.calls).toHaveLength(2)
    expect(client.calls[1]?.params.text).toBe('\x1b[200~/tmp/a.png\x1b[201~')
    expect(client.calls[0]?.params).not.toHaveProperty('client')
  })
})
