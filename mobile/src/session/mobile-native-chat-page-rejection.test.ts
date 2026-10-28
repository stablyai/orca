import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { RpcClient } from '../transport/rpc-client'
import {
  useMobileNativeChatSession,
  type MobileNativeChatSession
} from './use-mobile-native-chat-session'

// Catch fire-and-forget history failures, including absent/null success payloads, before they become document-level rejections.

function message(id: string): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text: id }],
    timestamp: 1,
    source: 'transcript'
  }
}

// Node emits 'unhandledRejection' a turn after the microtask queue drains.
async function settleRejections(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

// Temporarily own rejection listeners so assertions can inspect failures before Vitest handles them.
async function unhandledRejectionsWhile(run: () => Promise<void>): Promise<unknown[]> {
  const captured: unknown[] = []
  const previous = process.rawListeners('unhandledRejection')
  process.removeAllListeners('unhandledRejection')
  process.on('unhandledRejection', (reason) => captured.push(reason))
  try {
    await run()
    await settleRejections()
  } finally {
    process.removeAllListeners('unhandledRejection')
    for (const listener of previous) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: raw listeners handle this event; preserve their wrappers so once listeners still fire once.
      process.on('unhandledRejection', listener as NodeJS.UnhandledRejectionListener)
    }
  }
  return captured
}

describe('the native chat older-history page', () => {
  let renderer: ReactTestRenderer | null = null
  let state: MobileNativeChatSession | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    state = null
  })

  function Harness({ client }: { client: RpcClient }): null {
    state = useMobileNativeChatSession({
      client,
      sourceIdentity: 'host-a\0workspace-a',
      agent: 'claude',
      sessionId: 'session',
      transcriptPath: null
    })
    return null
  }

  function clientAnswering(page: () => Promise<unknown>): RpcClient {
    const subscribe: RpcClient['subscribe'] = vi.fn((_method, _params, onData) => {
      onData({
        type: 'snapshot',
        messages: Array.from({ length: 40 }, (_unused, index) => message(`old-${index}`)),
        hasMore: true,
        beforeOffset: 100
      })
      return () => {}
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reads only these two members, and `RpcSuccess` requires `result`, so a result-absent reply has no type.
    return { sendRequest: vi.fn(page), subscribe } as unknown as RpcClient
  }

  async function pageAgainst(client: RpcClient): Promise<void> {
    await act(async () => {
      renderer = create(createElement(Harness, { client }))
    })
    await act(async () => {
      state?.loadEarlier()
      await Promise.resolve()
    })
    expect(client.sendRequest).toHaveBeenCalledExactlyOnceWith(
      'nativeChat.readSession',
      {
        agent: 'claude',
        sessionId: 'session',
        limit: 60,
        beforeOffset: 100,
        capabilities: { transcriptSourceOrder: 1 }
      },
      { timeoutMs: expect.any(Number), budgetSpansConnect: true }
    )
    expect(state?.olderPages).toBe('failed')
  }

  it('contains a rejected page request instead of raising unhandledrejection', async () => {
    const captured = await unhandledRejectionsWhile(async () => {
      await pageAgainst(clientAnswering(() => Promise.reject(new Error('transport failure'))))
    })

    expect(captured).toEqual([])
    expect(state?.loadingEarlier).toBe(false)
    expect(state?.messages).toHaveLength(40)
  })

  const emptySuccesses = [
    { label: 'carries no result at all', reply: { ok: true } },
    { label: 'carries a null result', reply: { ok: true, result: null } }
  ]
  for (const { label, reply } of emptySuccesses) {
    it(`reads a success that ${label} without raising unhandledrejection`, async () => {
      const captured = await unhandledRejectionsWhile(async () => {
        await pageAgainst(clientAnswering(() => Promise.resolve(reply)))
      })

      expect(captured).toEqual([])
      expect(state?.loadingEarlier).toBe(false)
      expect(state?.messages).toHaveLength(40)
    })
  }
})
