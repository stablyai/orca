import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalCursor,
  AgentJournalRenderItem,
  AgentJournalResetReason
} from '../../../src/shared/agent-session-journal-types'
import { STRUCTURED_AGENT_SESSION_CLIENT_COALESCE_MS } from '../../../src/shared/structured-agent-session-coalescer'
import type {
  AgentSessionSubscribeEvent,
  AgentSessionHistoryPage
} from '../../../src/shared/agent-session-wire'
import { publishConnectionRevival } from '../transport/connection-revival-signal'
import type { RpcClient } from '../transport/rpc-client'
import { useMobileStructuredAgentState } from './use-mobile-structured-agent-state'

function cursorAt(sequence: number): AgentJournalCursor {
  return { epoch: 'epoch-1', sequence }
}

function said(
  sequence: number,
  agentId?: string,
  role: 'assistant' | 'user' = 'assistant'
): AgentJournalRenderItem {
  return {
    itemId: `item-${sequence}`,
    revision: 1,
    sequence,
    observedAt: sequence,
    body: { kind: 'message', role, blocks: [{ type: 'text', text: `${sequence}` }] },
    ...(agentId === undefined ? {} : { agentId })
  }
}

function range(from: number, to: number, agentId?: string): AgentJournalRenderItem[] {
  return Array.from({ length: to - from }, (_, index) => said(from + index, agentId))
}

function page(items: AgentJournalRenderItem[], hasOlder: boolean): AgentSessionHistoryPage {
  const oldest = items[0]
  const newest = items.at(-1)
  return {
    sessionId: 'session-1',
    epoch: 'epoch-1',
    fence: 1,
    direction: 'before',
    items,
    removedItemIds: [],
    submissions: [],
    window: {
      oldest: oldest ? cursorAt(oldest.sequence) : null,
      newest: newest ? cursorAt(newest.sequence) : null,
      nextCursor: cursorAt(oldest?.sequence ?? 0)
    },
    liveCursor: cursorAt(1_000),
    hasOlder,
    hasNewer: false
  }
}

describe('useMobileStructuredAgentState older history', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  // Serve cursor-addressed older pages, resets and throws behind the hook’s newest rows.
  async function mountWithOlderPages(
    older: Record<number, AgentSessionHistoryPage | AgentJournalResetReason | Error | undefined>,
    newest: AgentJournalRenderItem[] = [said(1_000)]
  ) {
    let onFrame: ((value: unknown) => void) | null = null
    const historyCursors: number[] = []
    const sendRequest = vi.fn(async (method: string, params?: { cursor?: AgentJournalCursor }) => {
      if (method !== 'agentSession.history' || !params?.cursor) {
        return { ok: true, result: {} }
      }
      historyCursors.push(params.cursor.sequence)
      const olderPage = older[params.cursor.sequence] ?? 'cursor_ahead'
      if (olderPage instanceof Error) {
        throw olderPage
      }
      return {
        ok: true,
        result:
          typeof olderPage === 'string'
            ? { ok: false, reset: olderPage }
            : { ok: true, page: olderPage }
      }
    })
    const subscribe = vi.fn(
      (_method: string, _params: unknown, frame: (value: unknown) => void) => {
        onFrame = frame
        return () => {}
      }
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an RPC client stub with the two members the hook calls.
    const client = { sendRequest, subscribe } as unknown as RpcClient
    const hook: { current: ReturnType<typeof useMobileStructuredAgentState> | null } = {
      current: null
    }
    function Harness(): null {
      hook.current = useMobileStructuredAgentState({
        client,
        sessionId: 'session-1',
        sessionKey: 'session-1',
        enabled: true,
        connected: true
      })
      return null
    }
    act(() => {
      renderer = create(createElement(Harness))
    })
    await vi.waitFor(() => expect(onFrame).not.toBeNull())
    act(() => {
      onFrame!({
        type: 'snapshot',
        sessionId: 'session-1',
        fence: 1,
        page: { ...page(newest, true), direction: 'tail' }
      })
    })
    await vi.waitFor(() => expect(hook.current!.state.status).toBe('ready'))
    return { hook, historyCursors, emit: (event: AgentSessionSubscribeEvent) => onFrame?.(event) }
  }

  it('keeps a row removed when its upsert and removal arrive within one streaming window', async () => {
    const { hook, emit } = await mountWithOlderPages({}, [])
    vi.useFakeTimers()
    try {
      const batch = {
        cursor: cursorAt(1001),
        items: [said(1001)],
        removedItemIds: [],
        submissions: []
      }
      act(() => emit({ type: 'batch', sessionId: 'session-1', batch }))
      act(() =>
        emit({
          type: 'batch',
          sessionId: 'session-1',
          batch: { ...batch, cursor: cursorAt(1002), items: [], removedItemIds: ['item-1001'] }
        })
      )
      await act(async () => {
        await vi.advanceTimersByTimeAsync(STRUCTURED_AGENT_SESSION_CLIENT_COALESCE_MS)
      })
      expect(hook.current!.state.items).toEqual([])
      expect(hook.current!.state.cursor?.sequence).toBe(1002)
    } finally {
      act(() => renderer?.unmount())
      renderer = null
      vi.useRealTimers()
    }
  })

  it("reads past pages of a subagent's rows to the session's own older rows", async () => {
    const { hook, historyCursors } = await mountWithOlderPages({
      1000: page(range(800, 1_000, 'task-1'), true),
      800: page(range(600, 800, 'task-1'), true),
      600: page(range(1, 101), false)
    })

    act(() => hook.current!.loadEarlier())

    await vi.waitFor(() => expect(hook.current!.state.items[0]?.sequence).toBe(1))
    expect(historyCursors).toEqual([1_000, 800, 600])
    expect(hook.current!.state.hasOlder).toBe(false)
  })

  it("stops at the first page that holds a row of the session's own", async () => {
    const { hook, historyCursors } = await mountWithOlderPages({
      1000: page([...range(800, 999, 'task-1'), said(999)], true),
      800: page(range(600, 800), true)
    })

    act(() => hook.current!.loadEarlier())

    await vi.waitFor(() => expect(hook.current!.state.items[0]?.sequence).toBe(800))
    expect(historyCursors).toEqual([1_000])
    expect(hook.current!.state.hasOlder).toBe(true)
  })

  it("reads back on its own when the newest page holds only a subagent's rows", async () => {
    const { hook, historyCursors } = await mountWithOlderPages(
      { 800: page(range(1, 101), false) },
      range(800, 1_000, 'task-1')
    )

    await vi.waitFor(() => expect(hook.current!.state.items[0]?.sequence).toBe(1))
    expect(historyCursors).toEqual([800])
  })

  it('reads back once from a window that draws nothing when the read lands nothing', async () => {
    const { hook, historyCursors } = await mountWithOlderPages({}, range(800, 1_000, 'task-1'))

    await vi.waitFor(() => expect(historyCursors).toEqual([800]))
    await vi.waitFor(() => expect(hook.current!.olderPages).toBe('idle'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(historyCursors).toEqual([800])
  })

  it('keeps the chat readable when an older page fails, retries on a tap, and ends at unreadable history', async () => {
    const older: Parameters<typeof mountWithOlderPages>[0] = { 1000: new Error('timed out') }
    const { hook } = await mountWithOlderPages(older)

    act(() => hook.current!.loadEarlier())
    await vi.waitFor(() => expect(hook.current!.olderPages).toBe('failed'))
    expect(hook.current!.state.status).toBe('ready')
    expect(hook.current!.state.items.map((item) => item.sequence)).toEqual([1_000])

    older[1000] = page(range(900, 1_000), true)
    older[900] = Object.assign(new Error('agent_session_journal_unreadable'), {
      data: {
        refusal: { code: 'agent_session_journal_unreadable', details: { reason: 'journalCorrupt' } }
      }
    })
    act(() => hook.current!.loadEarlier())
    await vi.waitFor(() => expect(hook.current!.state.items[0]?.sequence).toBe(900))
    expect(hook.current!.olderPages).toBe('idle')

    act(() => hook.current!.loadEarlier())
    await vi.waitFor(() => expect(hook.current!.olderPages).toBe('unavailable'))
    expect(hook.current!.state.status).toBe('ready')
    act(() => hook.current!.loadEarlier())
    expect(hook.current!.olderPages).toBe('unavailable')
  })
})

describe('useMobileStructuredAgentState live feed', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.useRealTimers()
  })

  it('reopens a feed that ended under a live connection from its last row', async () => {
    vi.useFakeTimers()
    const streams: { params: unknown; frame: (value: unknown) => void }[] = []
    const subscribe = vi.fn((_method: string, params: unknown, frame: (value: unknown) => void) => {
      streams.push({ params, frame })
      return () => {}
    })
    const sendRequest = vi.fn(async () => ({ ok: true, result: {} }))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an RPC client stub with the two members the hook calls.
    const client = { sendRequest, subscribe } as unknown as RpcClient
    const hook: { current: ReturnType<typeof useMobileStructuredAgentState> | null } = {
      current: null
    }
    function Harness(): null {
      hook.current = useMobileStructuredAgentState({
        client,
        sessionId: 'session-1',
        sessionKey: 'session-1',
        enabled: true,
        connected: true
      })
      return null
    }
    act(() => {
      renderer = create(createElement(Harness))
    })
    await vi.waitFor(() => expect(streams).toHaveLength(1))
    act(() =>
      streams[0].frame({
        type: 'snapshot',
        sessionId: 'session-1',
        fence: 1,
        page: { ...page([said(58), said(59)], false), direction: 'tail', liveCursor: cursorAt(59) }
      })
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })

    act(() => streams[0].frame({ type: 'error', message: 'Stream ended' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(750)
    })
    await vi.waitFor(() => expect(streams).toHaveLength(2))
    expect(streams[1].params).toEqual({ sessionId: 'session-1', cursor: cursorAt(59) })
    act(() =>
      streams[1].frame({
        type: 'batch',
        sessionId: 'session-1',
        batch: {
          cursor: cursorAt(61),
          items: [said(59), said(60, undefined, 'user'), said(61)],
          removedItemIds: [],
          submissions: []
        }
      })
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(hook.current!.state.items.map((item) => item.sequence)).toEqual([58, 59, 60, 61])
    expect(hook.current!.state.error).toBeUndefined()

    act(() => streams[1].frame({ type: 'end' }))
    act(() => publishConnectionRevival('app-resume'))
    await vi.waitFor(() => expect(streams).toHaveLength(3), { interval: 1, timeout: 50 })
    expect(streams[2].params).toEqual({ sessionId: 'session-1', cursor: cursorAt(61) })
  })
})
