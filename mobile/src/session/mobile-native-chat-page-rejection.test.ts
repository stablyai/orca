import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { RpcClient } from '../transport/rpc-client'
import {
  useMobileNativeChatSession,
  type MobileNativeChatSession
} from './use-mobile-native-chat-session'

/**
 * The older-history page is fire-and-forget, so anything that escapes its async body reaches the
 * document instead of a caller. `matrix-session.native-chat-page-nativechat.readsession-1` certified
 * five such effects at this one site: a rejected request (`transport failure`, and the empty-message
 * shape), a request the client abandons at teardown (`Connection closed`), and a `'error' in result`
 * read of a success whose result was absent or null, which throws a TypeError before any of that.
 */

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

/** Owns the handler for the run: vitest's own would red the file before an assertion reads it. */
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
      process.on('unhandledRejection', listener)
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

  /** A full first window with a cursor, which is what arms `hasMore` and lets a page go out. */
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
      // The delivered window is left exactly as it was, which is this operation's skip policy.
      expect(state?.loadingEarlier).toBe(false)
      expect(state?.messages).toHaveLength(40)
    })
  }
})
