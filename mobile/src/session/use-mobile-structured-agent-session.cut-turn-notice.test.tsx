import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../src/shared/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../../src/shared/agent-session-wire'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async () => null), setItem: vi.fn(), removeItem: vi.fn() }
}))

const SCOPE = { kind: 'turn' as const, turnItemId: 'turn-1' }
const ITEMS: AgentJournalRenderItem[] = [
  {
    itemId: 'user-1',
    revision: 0,
    sequence: 1,
    observedAt: 1,
    turnScope: { kind: 'thread' },
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'long job' }] }
  },
  {
    itemId: 'turn-1',
    revision: 1,
    sequence: 2,
    observedAt: 2,
    turnScope: { kind: 'thread' },
    body: {
      kind: 'turn',
      turnId: 'turn-1',
      userItemId: 'user-1',
      state: 'interrupted',
      startedAt: 2,
      completedAt: 9
    }
  },
  {
    itemId: 'reply-1',
    revision: 0,
    sequence: 3,
    observedAt: 3,
    turnScope: SCOPE,
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'half' }] }
  }
]

function snapshot(items: AgentJournalRenderItem[]): AgentSessionSubscribeEvent {
  return {
    type: 'snapshot',
    sessionId: 'session-1',
    fence: 3,
    page: {
      sessionId: 'session-1',
      epoch: 'epoch-1',
      fence: 3,
      direction: 'tail',
      items,
      removedItemIds: [],
      submissions: [],
      window: {
        oldest: { epoch: 'epoch-1', sequence: 1 },
        newest: { epoch: 'epoch-1', sequence: 3 },
        nextCursor: { epoch: 'epoch-1', sequence: 4 }
      },
      liveCursor: { epoch: 'epoch-1', sequence: 3 },
      hasOlder: false,
      hasNewer: false
    }
  }
}

describe('useMobileStructuredAgentSession transcript', () => {
  let renderer: ReactTestRenderer | null = null
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('shows a cut turn no row explains with the one notice desktop shows, in that turn', async () => {
    let listener: ((value: unknown) => void) | null = null
    const client: Pick<RpcClient, 'sendRequest' | 'subscribe'> = {
      sendRequest: vi.fn(async (): Promise<RpcResponse> => ({
        id: 'response-1',
        ok: true,
        result: {},
        _meta: { runtimeId: 'runtime-1' }
      })),
      subscribe: vi.fn((_method: string, _params: unknown, onData: (value: unknown) => void) => {
        listener = onData
        return () => {}
      })
    }
    const rendered: { hook: ReturnType<typeof useMobileStructuredAgentSession> | null } = {
      hook: null
    }
    function Harness(): null {
      rendered.hook = useMobileStructuredAgentSession({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook calls only sendRequest and subscribe, both provided.
        client: client as RpcClient,
        sessionId: 'session-1',
        enabled: true,
        connected: true,
        hostSupport: null,
        agent: 'codex',
        onSendError: vi.fn()
      })
      return null
    }
    act(() => {
      renderer = create(createElement(Harness))
    })
    await vi.waitFor(() => expect(listener).toEqual(expect.any(Function)))

    act(() => listener?.(snapshot(ITEMS)))

    await vi.waitFor(() =>
      expect(rendered.hook?.session.messages.at(-1)).toMatchObject({
        role: 'system',
        blocks: [
          {
            text: 'Codex stopped while this response was in progress. You can continue in this conversation.',
            tone: 'error'
          }
        ]
      })
    )
    // The turn bars place rows by the same items, so the notice joins the cut turn.
    expect(rendered.hook?.turnJournal.items.at(-1)).toMatchObject({ turnScope: SCOPE })
  })
})
