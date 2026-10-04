import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalCursor,
  AgentJournalRenderItem
} from '../../../src/shared/agent-session-journal-types'
import type { AgentSessionHistoryPage } from '../../../src/shared/agent-session-wire'
import type { RpcClient } from '../transport/rpc-client'
import { useMobileStructuredAgentState } from './use-mobile-structured-agent-state'

function cursorAt(sequence: number): AgentJournalCursor {
  return { epoch: 'epoch-1', sequence }
}

function said(sequence: number, agentId?: string): AgentJournalRenderItem {
  return {
    itemId: `item-${sequence}`,
    revision: 1,
    sequence,
    observedAt: sequence,
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: `${sequence}` }] },
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

  /** Mounts the hook on a session whose newest rows are `newest` (by default one of the
   *  session's own, at 1000), with the host serving `older` by the cursor each read asks before. */
  async function mountWithOlderPages(
    older: Record<number, AgentSessionHistoryPage | undefined>,
    newest: AgentJournalRenderItem[] = [said(1_000)],
    providerSession?: { key: 'session_id'; id: string },
    snapshotProviderSession?: { key: 'session_id'; id: string }
  ) {
    let onFrame: ((value: unknown) => void) | null = null
    const historyCursors: number[] = []
    const sendRequest = vi.fn(async (method: string, params?: { cursor?: AgentJournalCursor }) => {
      if (method !== 'agentSession.history' || !params?.cursor) {
        return { ok: true, result: {} }
      }
      historyCursors.push(params.cursor.sequence)
      const named = providerSession ? { providerSession } : {}
      const olderPage = older[params.cursor.sequence]
      return {
        ok: true,
        result: olderPage
          ? { ok: true, page: olderPage, ...named }
          : { ok: false, reset: 'cursor_ahead', ...named }
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
        page: page(newest, true),
        ...(snapshotProviderSession ? { providerSession: snapshotProviderSession } : {})
      })
    })
    await vi.waitFor(() => expect(hook.current!.state.status).toBe('ready'))
    return { hook, historyCursors }
  }

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
    await vi.waitFor(() => expect(hook.current!.loadingOlder).toBe(false))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(historyCursors).toEqual([800])
  })

  it('keeps the provider session a history read names', async () => {
    const { hook } = await mountWithOlderPages(
      { 800: page(range(1, 101), false) },
      range(800, 1_000, 'task-1'),
      { key: 'session_id', id: 'provider-1' }
    )

    await vi.waitFor(() =>
      expect(hook.current!.providerSessions.get('session-1')).toEqual({
        key: 'session_id',
        id: 'provider-1'
      })
    )
  })

  it('fills providerSessions from the opening snapshot, before any history read', async () => {
    const { hook, historyCursors } = await mountWithOlderPages({}, [said(1_000)], undefined, {
      key: 'session_id',
      id: 'from-snapshot'
    })

    expect(historyCursors).toEqual([])
    expect(hook.current!.providerSessions.get('session-1')).toEqual({
      key: 'session_id',
      id: 'from-snapshot'
    })
  })
})
