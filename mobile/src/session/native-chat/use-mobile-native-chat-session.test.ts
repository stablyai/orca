import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../src/shared/native-chat/native-chat-types'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { stubRpcClient } from '../../transport/rpc/rpc-client-test-stub'
import { publishPageDeviceStore } from '../../mobile-web-shell/bridge/page-device-store'
import { mobileNativeChatTranscriptCache } from './transcript/mobile-native-chat-transcript-cache'
import { encodeStoredChatTranscript } from './transcript/mobile-native-chat-transcript-encode'
import {
  useMobileNativeChatSession,
  type MobileNativeChatSession
} from './use-mobile-native-chat-session'

function message(id: string): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text: id }],
    timestamp: 1,
    source: 'transcript'
  }
}

beforeEach(() => mobileNativeChatTranscriptCache.clear())

describe('useMobileNativeChatSession', () => {
  let renderer: ReactTestRenderer | null = null
  let state: MobileNativeChatSession | null = null
  let emit: (frame: unknown) => void = () => {}

  beforeEach(() => {
    state = null
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function Harness({ client }: { client: RpcClient | null }): null {
    state = useMobileNativeChatSession({
      client,
      sourceIdentity: 'host-a\0workspace-a',
      agent: 'claude',
      sessionId: 'session',
      transcriptPath: null
    })
    return null
  }

  async function mount(client: RpcClient): Promise<void> {
    await act(async () => {
      renderer = create(createElement(Harness, { client }))
    })
  }

  it('drops an older-page response captured before transcript replacement', async () => {
    let resolveEarlier: (response: unknown) => void = () => {}
    const sendRequest = vi.fn(
      () => new Promise((resolve) => (resolveEarlier = resolve))
    ) as unknown as RpcClient['sendRequest']
    const subscribe: RpcClient['subscribe'] = vi.fn((_method, _params, onData) => {
      emit = onData
      onData({
        type: 'snapshot',
        messages: Array.from({ length: 40 }, (_unused, index) => message(`old-${index}`)),
        hasMore: true,
        beforeOffset: 100
      })
      return () => {}
    })
    await mount({ sendRequest, subscribe } as unknown as RpcClient)
    act(() => state?.loadEarlier())

    await act(async () => {
      emit({
        type: 'replacement',
        messages: [message('replacement')],
        hasMore: false,
        beforeOffset: 0
      })
    })
    await act(async () => {
      resolveEarlier({
        ok: true,
        result: { messages: [message('stale-page')], hasMore: false, beforeOffset: 0 }
      })
      await Promise.resolve()
    })

    expect(state?.messages.map((entry) => entry.id)).toEqual(['replacement'])
    expect(state?.loadingEarlier).toBe(false)
  })

  it('drops an older-page response after the client source disappears', async () => {
    let resolveEarlier: (response: unknown) => void = () => {}
    const sendRequest = vi.fn(
      () => new Promise((resolve) => (resolveEarlier = resolve))
    ) as unknown as RpcClient['sendRequest']
    const subscribe: RpcClient['subscribe'] = vi.fn((_method, _params, onData) => {
      onData({
        type: 'snapshot',
        messages: Array.from({ length: 40 }, (_unused, index) => message(`old-${index}`)),
        hasMore: true,
        beforeOffset: 100
      })
      return () => {}
    })
    await mount({ sendRequest, subscribe } as unknown as RpcClient)
    act(() => state?.loadEarlier())
    await act(async () => renderer?.update(createElement(Harness, { client: null })))
    await act(async () => {
      resolveEarlier({ ok: true, result: { messages: [message('stale-page')] } })
      await Promise.resolve()
    })

    // Retain visible history after source loss, but reject late pages from the retired source.
    expect(state?.messages.map((entry) => entry.id)).not.toContain('stale-page')
    expect(state?.messages).toHaveLength(40)
    expect(state?.status).toBe('idle')
    expect(state?.loadingEarlier).toBe(false)
  })

  it('keeps paged-in history across an auto-reconnect replay snapshot', async () => {
    // Reconnect replays the original small window; merge it into paged history instead of truncating.
    const sendRequest = vi.fn().mockResolvedValue({
      ok: true,
      result: {
        messages: Array.from({ length: 60 }, (_unused, index) => message(`paged-${index}`)),
        hasMore: false,
        beforeOffset: 40
      }
    })
    const window = Array.from({ length: 40 }, (_unused, index) => message(`win-${index}`))
    const subscribe: RpcClient['subscribe'] = vi.fn((_method, _params, onData) => {
      emit = onData
      onData({ type: 'snapshot', messages: window, hasMore: true, beforeOffset: 100 })
      return () => {}
    })
    await mount({ sendRequest, subscribe } as unknown as RpcClient)
    await act(async () => {
      state?.loadEarlier()
      await Promise.resolve()
    })
    expect(state?.messages).toHaveLength(100)

    await act(async () =>
      emit({ type: 'snapshot', messages: window, hasMore: true, beforeOffset: 100 })
    )
    expect(state?.messages).toHaveLength(100)
    expect(state?.messages[0]?.id).toBe('paged-0')

    await act(async () =>
      emit({
        type: 'snapshot',
        messages: [...window, message('live-1')],
        hasMore: true,
        beforeOffset: 100
      })
    )
    expect(state?.messages).toHaveLength(101)
    expect(state?.messages[0]?.id).toBe('paged-0')
    expect(state?.messages.at(-1)?.id).toBe('live-1')
  })

  it('fences an in-flight older page when a merging replay re-cuts the byte cursor', async () => {
    let resolveEarlier: (response: unknown) => void = () => {}
    const sendRequest = vi.fn(
      () => new Promise((resolve) => (resolveEarlier = resolve))
    ) as unknown as RpcClient['sendRequest']
    const retained = Array.from({ length: 40 }, (_unused, index) => message(`win-${index}`))
    const subscribe: RpcClient['subscribe'] = vi.fn((_method, _params, onData) => {
      emit = onData
      onData({ type: 'snapshot', messages: retained, hasMore: true, beforeOffset: 100 })
      return () => {}
    })
    await mount({ sendRequest, subscribe } as unknown as RpcClient)
    act(() => state?.loadEarlier())

    // Even an untrimmed replay can recut the cursor; an old in-flight page must not overwrite the new offset.
    await act(async () =>
      emit({ type: 'snapshot', messages: retained, hasMore: true, beforeOffset: 250 })
    )
    await act(async () => {
      resolveEarlier({
        ok: true,
        result: { messages: [message('stale-page')], hasMore: true, beforeOffset: 40 }
      })
      await Promise.resolve()
    })

    expect(state?.messages.some((entry) => entry.id === 'stale-page')).toBe(false)
    expect(state?.loadingEarlier).toBe(false)
  })

  it('keeps the base snapshot authoritative when a live append arrives first', async () => {
    const sendRequest = vi.fn()
    const subscribe: RpcClient['subscribe'] = vi.fn((_method, _params, onData) => {
      emit = onData
      return () => {}
    })
    await mount({ sendRequest, subscribe } as unknown as RpcClient)
    // Only snapshots establish the base; early appends cannot turn the first real snapshot into replay.
    await act(async () =>
      emit({ type: 'appended', messages: [message('early-a'), message('early-b')] })
    )
    await act(async () =>
      emit({
        type: 'snapshot',
        messages: [message('early-b'), message('base-c')],
        hasMore: true,
        beforeOffset: 3
      })
    )

    expect(state?.messages.map((entry) => entry.id)).toEqual(['early-b', 'base-c'])
  })
})

describe('useMobileNativeChatSession transcriptLoading', () => {
  let renderer: ReactTestRenderer | null = null
  const renders: {
    sessionId: string | null
    transcriptLoading: boolean
    status: string
    ids: string[]
  }[] = []

  beforeEach(() => {
    renders.length = 0
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function Harness({
    client,
    sessionId,
    agent = 'claude',
    sourceIdentity = 'host-a\0workspace-a'
  }: {
    client: RpcClient | null
    sessionId: string | null
    agent?: string | null
    sourceIdentity?: string
  }): null {
    const session = useMobileNativeChatSession({
      client,
      sourceIdentity,
      agent,
      sessionId,
      transcriptPath: null
    })
    renders.push({
      sessionId,
      transcriptLoading: session.transcriptLoading,
      status: session.status,
      ids: session.messages.map((entry) => entry.id)
    })
    return null
  }

  async function mountAt(client: RpcClient | null, sessionId: string | null): Promise<void> {
    await act(async () => {
      renderer = create(createElement(Harness, { client, sessionId }))
    })
  }

  it('re-reads instead of resurfacing a settled read when the same identity returns', async () => {
    // View toggles clear subscription state; retain settled history without claiming the reread is ready.
    const subscribe: RpcClient['subscribe'] = vi.fn((_method, _params, onData) => {
      onData({ type: 'snapshot', messages: [message('a-1')], hasMore: false })
      return () => {}
    })
    const client = { subscribe } as unknown as RpcClient
    await mountAt(client, 'session-a')
    expect(renders.at(-1)).toMatchObject({ status: 'ready', transcriptLoading: false })

    await act(async () =>
      renderer?.update(createElement(Harness, { client, sessionId: 'session-a', agent: null }))
    )
    renders.length = 0
    await act(async () =>
      renderer?.update(createElement(Harness, { client, sessionId: 'session-a', agent: 'claude' }))
    )

    expect(renders[0]).toMatchObject({
      status: 'loading',
      transcriptLoading: true,
      ids: ['a-1']
    })
  })

  it('keeps the last settled list rendered while a swapped client re-reads', async () => {
    // A new client invalidates the old ready verdict but must keep the cached conversation visible.
    const subscribe: RpcClient['subscribe'] = vi.fn((_method, _params, onData) => {
      onData({ type: 'snapshot', messages: [message('a-1')], hasMore: false })
      return () => {}
    })
    const client = { subscribe } as unknown as RpcClient
    await mountAt(client, 'session-a')
    expect(renders.at(-1)).toMatchObject({ status: 'ready' })

    let emitFresh: (frame: unknown) => void = () => {}
    const reconnected = {
      subscribe: vi.fn((_method: string, _params: unknown, onData: (frame: unknown) => void) => {
        emitFresh = onData
        return () => {}
      })
    } as unknown as RpcClient
    renders.length = 0
    await act(async () =>
      renderer?.update(createElement(Harness, { client: reconnected, sessionId: 'session-a' }))
    )

    expect(renders[0]).toMatchObject({
      status: 'loading',
      transcriptLoading: true,
      ids: ['a-1']
    })
    // Check every commit: passive resubscribe reset could blank history after a first-frame assertion passed.
    expect([...new Set(renders.map((entry) => entry.ids.join(',')))]).toEqual(['a-1'])

    await act(async () =>
      emitFresh({ type: 'snapshot', messages: [message('a-1'), message('a-2')], hasMore: false })
    )
    expect(renders.at(-1)).toMatchObject({
      status: 'ready',
      transcriptLoading: false,
      ids: ['a-1', 'a-2']
    })
  })

  it('keeps the retained transcript rendered when the stream reports an error', async () => {
    // Failed rereads must retain the last settled history until newer history replaces it.
    let emitFrame: (frame: unknown) => void = () => {}
    const client = {
      subscribe: vi.fn((_method: string, _params: unknown, onData: (frame: unknown) => void) => {
        emitFrame = onData
        onData({ type: 'snapshot', messages: [message('a-1')], hasMore: false })
        return () => {}
      })
    } as unknown as RpcClient
    await mountAt(client, 'session-a')
    expect(renders.at(-1)).toMatchObject({ status: 'ready', ids: ['a-1'] })

    renders.length = 0
    await act(async () => emitFrame({ type: 'error', message: 'stream broke' }))

    expect(renders.at(-1)).toMatchObject({
      status: 'error',
      transcriptLoading: false,
      ids: ['a-1']
    })
  })

  it('never holds a cached list across a host/workspace source change', async () => {
    const firstClient = {
      subscribe: vi.fn((_method: string, _params: unknown, onData: (frame: unknown) => void) => {
        onData({ type: 'snapshot', messages: [message('source-a')], hasMore: false })
        return () => {}
      })
    } as unknown as RpcClient
    await mountAt(firstClient, 'session-a')

    const secondClient = { subscribe: vi.fn(() => () => {}) } as unknown as RpcClient
    renders.length = 0
    await act(async () =>
      renderer?.update(
        createElement(Harness, {
          client: secondClient,
          sessionId: 'session-a',
          sourceIdentity: 'host-b\0workspace-b'
        })
      )
    )

    expect(renders[0]).toMatchObject({ status: 'loading', ids: [] })
  })

  it('never hands out the previous session’s messages under the new session id', async () => {
    const subscribe: RpcClient['subscribe'] = vi.fn((_method, params, onData) => {
      if ((params as { sessionId: string }).sessionId === 'session-a') {
        onData({ type: 'snapshot', messages: [message('a-1')], hasMore: false })
      }
      return () => {}
    })
    const client = { subscribe } as unknown as RpcClient
    await mountAt(client, 'session-a')
    await act(async () =>
      renderer?.update(createElement(Harness, { client, sessionId: 'session-b' }))
    )

    // The passive reset lags one commit; session-a rows must never surface under session-b.
    const leaked = renders.find(
      (entry) => entry.sessionId === 'session-b' && entry.ids.includes('a-1')
    )
    expect(leaked).toBeUndefined()
    expect(renders.find((entry) => entry.sessionId === 'session-b')).toMatchObject({
      transcriptLoading: true,
      ids: []
    })
  })

  it('takes the real snapshot after a pending one as this subscription’s base', async () => {
    let emitFrame: (frame: unknown) => void = () => {}
    const client = {
      subscribe: vi.fn((_method: string, _params: unknown, onData: (frame: unknown) => void) => {
        emitFrame = onData
        onData({ type: 'snapshot', messages: [], hasMore: false, pending: true })
        return () => {}
      })
    } as unknown as RpcClient
    await mountAt(client, 'session-a')

    await act(async () =>
      emitFrame({ type: 'appended', messages: [message('early-a'), message('early-b')] })
    )
    await act(async () =>
      emitFrame({
        type: 'snapshot',
        messages: [message('early-b'), message('base-c')],
        hasMore: true,
        beforeOffset: 100
      })
    )

    expect(renders.at(-1)).toMatchObject({
      status: 'ready',
      transcriptLoading: false,
      ids: ['early-b', 'base-c']
    })
  })

  it('never captures a pending window over the retained transcript', async () => {
    const client = {
      subscribe: vi.fn((_method: string, _params: unknown, onData: (frame: unknown) => void) => {
        onData({ type: 'snapshot', messages: [message('a-1')], hasMore: false })
        return () => {}
      })
    } as unknown as RpcClient
    await mountAt(client, 'session-a')

    const reconnected = {
      subscribe: vi.fn((_method: string, _params: unknown, onData: (frame: unknown) => void) => {
        onData({ type: 'snapshot', messages: [], hasMore: false, pending: true })
        return () => {}
      })
    } as unknown as RpcClient
    await act(async () =>
      renderer?.update(createElement(Harness, { client: reconnected, sessionId: 'session-a' }))
    )

    const rebound = { subscribe: vi.fn(() => () => {}) } as unknown as RpcClient
    renders.length = 0
    await act(async () =>
      renderer?.update(createElement(Harness, { client: rebound, sessionId: 'session-a' }))
    )

    expect(renders.at(-1)).toMatchObject({ status: 'loading', ids: ['a-1'] })
  })
})

describe('useMobileNativeChatSession after a relaunch', () => {
  let renderer: ReactTestRenderer | null = null
  let stored: string | null = null

  beforeEach(() => {
    publishPageDeviceStore({
      available: () => true,
      read: async (_table, keys) => ({
        status: 'ok',
        values: keys.map((key) => (key.startsWith('transcript:') ? stored : null))
      }),
      write: async () => ({ written: true })
    })
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    publishPageDeviceStore(null)
  })

  it('paints the stored rows and subscribes after the newest one', async () => {
    // What an earlier launch's page saved when this chat's turn settled.
    stored = await encodeStoredChatTranscript({
      kind: 'terminal',
      savedAt: 1_700_000_000_000,
      messages: [
        { ...message('m1'), transcriptOrder: 100 },
        { ...message('m2'), transcriptOrder: 200 }
      ],
      hasMore: false,
      beforeOffset: null
    })
    const subscribe = vi.fn<RpcClient['subscribe']>(() => () => {})
    const client = stubRpcClient({ subscribe })
    const seen: { state: MobileNativeChatSession | null } = { state: null }
    function Harness(): null {
      seen.state = useMobileNativeChatSession({
        client,
        sourceIdentity: 'host-a\0relaunched',
        agent: 'claude',
        sessionId: 'session',
        transcriptPath: null
      })
      return null
    }
    await act(async () => {
      renderer = create(createElement(Harness))
    })

    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(subscribe.mock.calls[0]?.[1]).toMatchObject({
      resumeAfter: { id: 'm2', transcriptOrder: 200, timestamp: 1 }
    })
    expect(seen.state?.messages.map((entry) => entry.id)).toEqual(['m1', 'm2'])
    expect(seen.state?.savedAt).toBe(1_700_000_000_000)
  })
})
