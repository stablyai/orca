import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../../../transport/rpc-client'
import type { RpcResponse, RpcSuccess } from '../../../transport/types'
import { pasteMobileNativeChatImagePaths } from './mobile-native-chat-image-send'
import { buildAgentTuiClearInputForText } from '../../../../../src/shared/agent-tui-input-clear'

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
  it.each([false, true])(
    'separates OMP references with following text: %s',
    async (followedByText) => {
      const client = clientWithResponses([sendResult(true), sendResult(true), sendResult(true)])
      await pasteMobileNativeChatImagePaths({
        client,
        terminal: 'term-1',
        agent: 'omp',
        deviceToken: null,
        imagePaths: ['/tmp/a.png', '/tmp/b.png'],
        followedByText
      })
      expect(client.calls.map((call) => call.params.text)).toEqual([
        '\x15',
        '\x1b[200~@/tmp/a.png\x1b[201~ ',
        `\x1b[200~@/tmp/b.png\x1b[201~${followedByText ? ' ' : ''}`
      ])
    }
  )

  it.each(['omp', null, undefined])('sends portable references for %s', async (agent) => {
    const client = clientWithResponses([sendResult(true), sendResult(true)])
    await pasteMobileNativeChatImagePaths({
      client,
      terminal: 'term-1',
      agent,
      deviceToken: null,
      imagePaths: ['/tmp/my image.png'],
      followedByText: true
    })
    expect(client.calls[1]?.params).toMatchObject({
      text: '\x1b[200~@"/tmp/my image.png"\x1b[201~ ',
      enter: false
    })
  })

  it.each([
    ['/tmp/my image.png', '/tmp/my\\ image.png'],
    ['C:\\Users\\John Doe\\shot.png', '"C:\\Users\\John Doe\\shot.png"']
  ])('escapes attachment-agent path %s like a terminal drop', async (path, pasted) => {
    const client = clientWithResponses([sendResult(true), sendResult(true)])
    await pasteMobileNativeChatImagePaths({
      client,
      terminal: 'term-1',
      agent: 'claude',
      deviceToken: null,
      imagePaths: [path],
      followedByText: false
    })
    expect(client.calls[1]?.params.text).toBe(`\x1b[200~${pasted}\x1b[201~`)
  })

  it('clears the input line, then pastes each path as a bracketed, non-submitting terminal.send with the mobile client tag', async () => {
    const client = clientWithResponses([
      sendResult(true),
      sendResult(true),
      sendResult(true),
      sendResult(true)
    ])

    const ok = await pasteMobileNativeChatImagePaths({
      client,
      agent: 'claude',
      terminal: 'term-1',
      deviceToken: 'device-9',
      imagePaths: ['/tmp/a.png', '/tmp/b.png', '/tmp/c.png'],
      followedByText: true
    })

    expect(ok).toBe(true)
    expect(client.calls).toHaveLength(4)
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
    expect(client.calls[3]?.params.text).toBe('\x1b[200~/tmp/c.png\x1b[201~ ')
  })

  it('stops and reports failure as soon as a paste is rejected', async () => {
    const client = clientWithResponses([sendResult(true), sendResult(false)])

    const ok = await pasteMobileNativeChatImagePaths({
      client,
      agent: 'claude',
      terminal: 'term-1',
      deviceToken: null,
      imagePaths: ['/tmp/a.png', '/tmp/b.png'],
      followedByText: true
    })

    expect(ok).toBe(false)
    expect(client.calls).toHaveLength(2)
    expect(client.calls[1]?.params.text).toBe('\x1b[200~/tmp/a.png\x1b[201~')
    expect(client.calls[0]?.params).not.toHaveProperty('client')
  })

  it('aborts rather than scheduling a write past the shared paste deadline', async () => {
    vi.useFakeTimers()
    try {
      const responses = [sendResult(true), sendResult(true), sendResult(true)]
      const calls: { timeoutMs: unknown }[] = []
      // Spend 10s per write so the third attempt exceeds the shared 15s sequence budget.
      const client = {
        sendRequest: vi.fn(async (_method: string, _params?: unknown, options?: unknown) => {
          calls.push({ timeoutMs: (options as { timeoutMs: number }).timeoutMs })
          vi.advanceTimersByTime(10_000)
          return responses.shift()!
        })
      }

      const ok = await pasteMobileNativeChatImagePaths({
        client,
        agent: 'claude',
        terminal: 'term-1',
        deviceToken: null,
        imagePaths: ['/tmp/a.png', '/tmp/b.png'],
        followedByText: true
      })

      expect(ok).toBe(false)
      expect(calls).toHaveLength(2)
      expect(calls[0]?.timeoutMs).toBe(15_000)
      expect(calls[1]?.timeoutMs).toBe(5_000)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('clearing a parked multi-line launch draft before the image paste', () => {
  it('leads with the caller-sized burst instead of one Ctrl+U', async () => {
    // One Ctrl+U clears only the last logical line; earlier launch-draft lines must not ride with images.
    const client = clientWithResponses([sendResult(true), sendResult(true)])
    const clearInput = buildAgentTuiClearInputForText('Linked Linear issue: ABC-123\nhttps://x')

    await pasteMobileNativeChatImagePaths({
      client,
      agent: 'claude',
      terminal: 'term-1',
      deviceToken: null,
      imagePaths: ['/tmp/a.png'],
      followedByText: true,
      clearInput
    })

    expect(client.calls[0]?.params.text).toBe(clearInput)
    expect(client.calls[0]?.params.text).not.toBe('\x15')
  })

  it('clears once, before the paste — never between or after the image writes', async () => {
    const client = clientWithResponses([sendResult(true), sendResult(true), sendResult(true)])
    const clearInput = buildAgentTuiClearInputForText('a\nb\nc')

    await pasteMobileNativeChatImagePaths({
      client,
      agent: 'claude',
      terminal: 'term-1',
      deviceToken: null,
      imagePaths: ['/tmp/a.png', '/tmp/b.png'],
      followedByText: true,
      clearInput
    })

    expect(client.calls.filter((call) => call.params.text === clearInput)).toHaveLength(1)
    expect(client.calls[0]?.params.text).toBe(clearInput)
  })

  it('keeps image writes byte-clean when no text or submit follows', async () => {
    const client = clientWithResponses([sendResult(true), sendResult(true), sendResult(true)])

    await pasteMobileNativeChatImagePaths({
      client,
      agent: 'claude',
      terminal: 'term-1',
      deviceToken: null,
      imagePaths: ['/tmp/a.png', '/tmp/b.png'],
      followedByText: false
    })

    expect(client.calls.slice(1).map((call) => call.params.text)).toEqual([
      '\x1b[200~/tmp/a.png\x1b[201~',
      '\x1b[200~/tmp/b.png\x1b[201~'
    ])
  })
})
