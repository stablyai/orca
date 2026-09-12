import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse, RpcSuccess } from '../transport/types'
import { pasteMobileNativeChatImagePaths } from './mobile-native-chat-image-send'
import { buildAgentTuiClearInputForText } from '../../../src/shared/agent-tui-input-clear'
import { NATIVE_CHAT_SUPPORTED_AGENT_LIST } from '../../../src/shared/native-chat-agent-support'
import { getNativeChatAttachmentForm } from '../../../src/shared/native-chat-agent-profiles'

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
    const client = clientWithResponses([
      sendResult(true),
      sendResult(true),
      sendResult(true),
      sendResult(true)
    ])

    const ok = await pasteMobileNativeChatImagePaths({
      client,
      terminal: 'term-1',
      deviceToken: 'device-9',
      agent: 'claude',
      imagePaths: ['/tmp/a.png', '/tmp/b.png', '/tmp/c.png'],
      followedByText: true
    })

    expect(ok).toBe(true)
    expect(client.calls).toHaveLength(4)
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
    expect(client.calls[3]?.params.text).toBe('\x1b[200~/tmp/c.png\x1b[201~ ')
  })

  it('stops and reports failure as soon as a paste is rejected', async () => {
    // Clear accepted, first image paste rejected.
    const client = clientWithResponses([sendResult(true), sendResult(false)])

    const ok = await pasteMobileNativeChatImagePaths({
      client,
      terminal: 'term-1',
      deviceToken: null,
      agent: 'claude',
      imagePaths: ['/tmp/a.png', '/tmp/b.png'],
      followedByText: true
    })

    expect(ok).toBe(false)
    // Never attempts the second path after the first is rejected.
    expect(client.calls).toHaveLength(2)
    expect(client.calls[1]?.params.text).toBe('\x1b[200~/tmp/a.png\x1b[201~')
    expect(client.calls[0]?.params).not.toHaveProperty('client')
  })

  it('aborts rather than scheduling a write past the shared paste deadline', async () => {
    vi.useFakeTimers()
    try {
      const responses = [sendResult(true), sendResult(true), sendResult(true)]
      const calls: { timeoutMs: unknown }[] = []
      // Each write burns 10s, so the 15s sequence budget is spent by the third.
      const client = {
        sendRequest: vi.fn(async (_method: string, _params?: unknown, options?: unknown) => {
          calls.push({ timeoutMs: (options as { timeoutMs: number }).timeoutMs })
          vi.advanceTimersByTime(10_000)
          return responses.shift()!
        })
      }

      const ok = await pasteMobileNativeChatImagePaths({
        client,
        terminal: 'term-1',
        deviceToken: null,
        agent: 'claude',
        imagePaths: ['/tmp/a.png', '/tmp/b.png'],
        followedByText: true
      })

      expect(ok).toBe(false)
      // Clear + first image only; the second image is never written.
      expect(calls).toHaveLength(2)
      expect(calls[0]?.timeoutMs).toBe(15_000)
      // Positive-but-small remainder still gets the floor.
      expect(calls[1]?.timeoutMs).toBe(5_000)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('clearing a parked multi-line launch draft before the image paste', () => {
  it('leads with the caller-sized burst instead of one Ctrl+U', async () => {
    // One Ctrl+U kills only the LAST line, so the draft's earlier lines would
    // survive and ride along with the image as part of the prompt body.
    const client = clientWithResponses([sendResult(true), sendResult(true)])
    const clearInput = buildAgentTuiClearInputForText('Linked Linear issue: ABC-123\nhttps://x')

    await pasteMobileNativeChatImagePaths({
      client,
      terminal: 'term-1',
      deviceToken: null,
      agent: 'claude',
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
      terminal: 'term-1',
      deviceToken: null,
      agent: 'claude',
      imagePaths: ['/tmp/a.png', '/tmp/b.png'],
      followedByText: true,
      clearInput
    })

    expect(client.calls.filter((call) => call.params.text === clearInput)).toHaveLength(1)
    expect(client.calls[0]?.params.text).toBe(clearInput)
  })

  it('falls back to a single Ctrl+U when no draft is parked', async () => {
    const client = clientWithResponses([sendResult(true), sendResult(true)])

    await pasteMobileNativeChatImagePaths({
      client,
      terminal: 'term-1',
      deviceToken: null,
      agent: 'claude',
      imagePaths: ['/tmp/a.png'],
      followedByText: true
    })

    expect(client.calls[0]?.params.text).toBe('\x15')
  })

  it('keeps image writes byte-clean when no text or submit follows', async () => {
    const client = clientWithResponses([sendResult(true), sendResult(true), sendResult(true)])

    await pasteMobileNativeChatImagePaths({
      client,
      terminal: 'term-1',
      deviceToken: null,
      agent: 'claude',
      imagePaths: ['/tmp/a.png', '/tmp/b.png'],
      followedByText: false
    })

    expect(client.calls.slice(1).map((call) => call.params.text)).toEqual([
      '\x1b[200~/tmp/a.png\x1b[201~',
      '\x1b[200~/tmp/b.png\x1b[201~'
    ])
  })
})

describe('the attachment form mobile writes per agent', () => {
  async function writesFor(agent: string | null, imagePaths: string[]): Promise<string[]> {
    const client = clientWithResponses(
      imagePaths.map(() => sendResult(true)).concat(sendResult(true))
    )
    const ok = await pasteMobileNativeChatImagePaths({
      client,
      terminal: 'term-1',
      deviceToken: null,
      agent,
      imagePaths,
      followedByText: true
    })
    expect(ok).toBe(true)
    // Drop the leading clear; only the attachment writes are under test.
    return client.calls.slice(1).map((call) => String(call.params.text))
  }

  it.each([
    ['claude', 'image-paste'],
    ['codex', 'image-paste'],
    ['grok', 'image-paste'],
    // OMP wraps Pi's TUI, which has no verified image-path paste gesture.
    ['omp', 'file-reference'],
    ['some-custom-agent', 'file-reference'],
    [null, 'file-reference']
  ] as const)('sends %s the %s form', async (agent, form) => {
    const writes = await writesFor(agent, ['/tmp/a.png'])
    expect(writes).toEqual(
      form === 'image-paste' ? ['\x1b[200~/tmp/a.png\x1b[201~ '] : ['@/tmp/a.png ']
    )
  })

  it('separates every @path reference, since a reference is not self-delimiting', async () => {
    expect(await writesFor('omp', ['/tmp/a.png', '/tmp/b.png'])).toEqual([
      '@/tmp/a.png ',
      '@/tmp/b.png '
    ])
    // The bracketed frame closes itself, so only the last write needs the space.
    expect(await writesFor('claude', ['/tmp/a.png', '/tmp/b.png'])).toEqual([
      '\x1b[200~/tmp/a.png\x1b[201~',
      '\x1b[200~/tmp/b.png\x1b[201~ '
    ])
  })

  it('frames a CR/LF filename so a reference cannot submit the turn early', async () => {
    const [write] = await writesFor('omp', ['/tmp/a\nb.png'])
    expect(write).toBe('\x1b[200~@"/tmp/a\rb.png"\x1b[201~ ')
    expect(write?.startsWith('\x1b[200~')).toBe(true)
  })

  it('quotes a spaced path so the reference stays one token', async () => {
    expect(await writesFor('omp', ['/tmp/my shot.png'])).toEqual(['@"/tmp/my shot.png" '])
  })

  it('agrees with the shared per-agent rule for every native-chat agent', async () => {
    for (const agent of NATIVE_CHAT_SUPPORTED_AGENT_LIST) {
      const [write] = await writesFor(agent, ['/tmp/a.png'])
      expect(write?.startsWith('\x1b[200~')).toBe(
        getNativeChatAttachmentForm(agent) === 'image-paste'
      )
    }
  })
})
