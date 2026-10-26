import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { RpcClient } from '../transport/rpc-client'
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

  it.each(['replacement', 'snapshot'] as const)(
    'can page again after an authoritative %s resets a maxed-out read window',
    async (frameType) => {
      const sendRequest = vi.fn().mockResolvedValue({
        ok: true,
        result: { messages: [message('older')], hasMore: true, beforeOffset: 50 }
      })
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
      for (let page = 0; page < 33; page += 1) {
        await act(async () => {
          state?.loadEarlier()
          await Promise.resolve()
        })
      }
      const requestsAtCap = sendRequest.mock.calls.length
      expect(requestsAtCap).toBe(33)
      expect(state?.hasMore).toBe(false)
      expect(sendRequest).toHaveBeenLastCalledWith(
        'nativeChat.readSession',
        { agent: 'claude', sessionId: 'session', limit: 40, beforeOffset: 50 },
        expect.objectContaining({ budgetSpansConnect: true })
      )
      await act(async () => state?.loadEarlier())
      expect(sendRequest).toHaveBeenCalledTimes(33)

      await act(async () =>
        emit({
          type: frameType,
          messages: [message('authoritative')],
          hasMore: true,
          beforeOffset: 500
        })
      )
      await act(async () => {
        state?.loadEarlier()
        await Promise.resolve()
      })

      expect(sendRequest).toHaveBeenCalledTimes(requestsAtCap + 1)
      expect(sendRequest).toHaveBeenLastCalledWith(
        'nativeChat.readSession',
        { agent: 'claude', sessionId: 'session', limit: 60, beforeOffset: 500 },
        expect.objectContaining({ budgetSpansConnect: true })
      )
    }
  )

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

  it('keeps the rows it shows when a replay window has moved past them', async () => {
    const sendRequest = vi.fn(() => new Promise<never>(() => {}))
    const window = Array.from({ length: 40 }, (_unused, index) => message(`win-${index}`))
    const subscribe: RpcClient['subscribe'] = vi.fn((_method, _params, onData) => {
      emit = onData
      onData({ type: 'snapshot', messages: window, hasMore: false, beforeOffset: 0 })
      return () => {}
    })
    await mount({ sendRequest, subscribe } as unknown as RpcClient)

    await act(async () =>
      emit({
        type: 'snapshot',
        messages: [...window.slice(1), message('live-1')],
        hasMore: true,
        beforeOffset: 10
      })
    )

    expect(state?.messages.map((entry) => entry.id)).toEqual([
      ...window.map((entry) => entry.id),
      'live-1'
    ])
    expect(state?.hasMore).toBe(false)
  })

  it('drops paged rows that an authoritative replay says were removed', async () => {
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
      emit({ type: 'snapshot', messages: window, hasMore: false, beforeOffset: 0 })
    )

    expect(state?.messages).toEqual(window)
    expect(state?.hasMore).toBe(false)
  })

  it('clears a stale cursor when a replacement omits paging metadata', async () => {
    const sendRequest = vi.fn(() => new Promise<never>(() => {}))
    const subscribe: RpcClient['subscribe'] = vi.fn((_method, _params, onData) => {
      emit = onData
      onData({
        type: 'snapshot',
        messages: Array.from({ length: 40 }, (_unused, index) => message(`win-${index}`)),
        hasMore: true,
        beforeOffset: 100
      })
      return () => {}
    })
    await mount({ sendRequest, subscribe } as unknown as RpcClient)

    await act(async () =>
      emit({
        type: 'replacement',
        messages: Array.from({ length: 40 }, (_unused, index) => message(`new-${index}`))
      })
    )
    act(() => state?.loadEarlier())

    expect(sendRequest).toHaveBeenCalledWith(
      'nativeChat.readSession',
      { agent: 'claude', sessionId: 'session', limit: 100 },
      expect.objectContaining({ budgetSpansConnect: true })
    )
  })

  it('clears hasMore when a replaced window is shorter than the initial page', async () => {
    const sendRequest = vi.fn()
    const subscribe: RpcClient['subscribe'] = vi.fn((_method, _params, onData) => {
      emit = onData
      onData({
        type: 'snapshot',
        messages: Array.from({ length: 40 }, (_unused, index) => message(`win-${index}`)),
        hasMore: true,
        beforeOffset: 100
      })
      return () => {}
    })
    await mount({ sendRequest, subscribe } as unknown as RpcClient)
    expect(state?.hasMore).toBe(true)

    await act(async () => emit({ type: 'replacement', messages: [message('only')] }))

    expect(state?.hasMore).toBe(false)
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

  it('lands a page across a same-cursor replay, and flags a refused page until the next tap', async () => {
    const pages: ((response: unknown) => void)[] = []
    const sendRequest = vi.fn(() => new Promise((resolve) => pages.push(resolve)))
    const window = Array.from({ length: 40 }, (_unused, index) => message(`win-${index}`))
    const snapshot = { type: 'snapshot', messages: window, hasMore: true, beforeOffset: 100 }
    const subscribe: RpcClient['subscribe'] = vi.fn((_method, _params, onData) => {
      emit = onData
      onData(snapshot)
      return () => {}
    })
    await mount({ sendRequest, subscribe } as unknown as RpcClient)
    const answer = (response: unknown) =>
      act(async () => {
        pages.at(-1)?.(response)
        await Promise.resolve()
      })

    act(() => state?.loadEarlier())
    await act(async () => emit(snapshot))
    await answer({
      ok: true,
      result: { messages: [message('older')], hasMore: true, beforeOffset: 40 }
    })
    expect(state?.messages.map((entry) => entry.id)).toEqual([
      'older',
      ...window.map((entry) => entry.id)
    ])

    act(() => state?.loadEarlier())
    await answer({ id: 'x', ok: false, error: { code: 'refused', message: 'refused' } })
    expect(state?.olderPages).toBe('failed')
    expect(state?.loadingEarlier).toBe(false)
    act(() => state?.loadEarlier())
    expect(sendRequest).toHaveBeenCalledTimes(3)
    expect(state?.olderPages).toBe('loading')
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

  it('keeps every row it shows while live output outgrows the first window', async () => {
    let resolvePage: (response: unknown) => void = () => {}
    const sendRequest = vi
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => (resolvePage = resolve)))
      .mockImplementation(() => new Promise<never>(() => {}))
    const window = Array.from({ length: 40 }, (_unused, index) => message(`window-${index}`))
    const subscribe: RpcClient['subscribe'] = vi.fn((_method, _params, onData) => {
      emit = onData
      onData({ type: 'snapshot', messages: window, hasMore: true, beforeOffset: 100 })
      return () => {}
    })
    await mount({ sendRequest, subscribe } as unknown as RpcClient)
    const shown = window.map((entry) => entry.id)

    act(() => state?.loadEarlier())
    await act(async () => emit({ type: 'appended', messages: [message('live-1')] }))
    expect(state?.messages.map((entry) => entry.id)).toEqual([...shown, 'live-1'])

    await act(async () => {
      resolvePage({
        ok: true,
        result: { messages: [message('older-page')], hasMore: true, beforeOffset: 50 }
      })
      await Promise.resolve()
    })
    expect(state?.messages.map((entry) => entry.id)).toEqual(['older-page', ...shown, 'live-1'])
  })

  it('pages a growing tail from what the phone holds, not from the first window', async () => {
    const sendRequest = vi.fn(() => new Promise<never>(() => {}))
    const subscribe: RpcClient['subscribe'] = vi.fn((_method, _params, onData) => {
      emit = onData
      onData({
        type: 'snapshot',
        messages: Array.from({ length: 40 }, (_unused, index) => message(`window-${index}`)),
        hasMore: true
      })
      return () => {}
    })
    await mount({ sendRequest, subscribe } as unknown as RpcClient)
    await act(async () =>
      emit({
        type: 'appended',
        messages: Array.from({ length: 30 }, (_unused, index) => message(`live-${index}`))
      })
    )

    act(() => state?.loadEarlier())

    expect(sendRequest).toHaveBeenLastCalledWith(
      'nativeChat.readSession',
      { agent: 'claude', sessionId: 'session', limit: 130 },
      expect.objectContaining({ budgetSpansConnect: true })
    )
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

  it('reports loading on the very first render, before the subscription effect runs', async () => {
    // Idle alone cannot make an empty pre-read transcript trustworthy for launch seeding.
    const subscribe: RpcClient['subscribe'] = vi.fn(() => () => {})
    await mountAt({ subscribe } as unknown as RpcClient, 'session-a')

    expect(renders[0]).toMatchObject({ transcriptLoading: true, ids: [] })
  })

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

  it('settles the view but not the read on a pending snapshot', async () => {
    // Pending means no file yet: render without a spinner, but do not call empty history ready for launch seeding.
    const subscribe: RpcClient['subscribe'] = vi.fn((_method, _params, onData) => {
      onData({ type: 'snapshot', messages: [], hasMore: false, pending: true })
      return () => {}
    })
    await mountAt({ subscribe } as unknown as RpcClient, 'session-a')

    expect(subscribe).toHaveBeenCalledWith(
      'nativeChat.subscribe',
      expect.objectContaining({ capabilities: { transcriptPending: 1 } }),
      expect.any(Function)
    )
    expect(renders.at(-1)).toMatchObject({
      status: 'awaiting-transcript',
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
