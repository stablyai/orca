import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalCursor,
  AgentJournalRenderItem
} from '../../../src/shared/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../../src/shared/agent-session-wire'
import { STRUCTURED_AGENT_SESSION_CLIENT_COALESCE_MS } from '../../../src/shared/structured-agent-session-coalescer'
import type { SubscribeOptions } from '../transport/rpc-client-contract'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'

vi.mock('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: () => {} }) }
}))

const SESSION_ID = 'session-a'
const EPOCH = 'epoch-a'

function cursor(sequence: number): AgentJournalCursor {
  return { epoch: EPOCH, sequence }
}

// Assistant-message batches are the ones the coalescer holds; anything else
// bypasses it and would dispatch synchronously, hiding the window under test.
function assistantItem(sequence: number): AgentJournalRenderItem {
  return {
    itemId: `item-${sequence}`,
    revision: 1,
    sequence,
    observedAt: sequence,
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: `m${sequence}` }] }
  }
}

function batchEvent(sequence: number): AgentSessionSubscribeEvent {
  return {
    type: 'batch',
    sessionId: SESSION_ID,
    batch: {
      cursor: cursor(sequence),
      items: [assistantItem(sequence)],
      removedItemIds: [],
      submissions: []
    }
  }
}

function tailResponse(liveCursor: AgentJournalCursor): RpcResponse {
  return {
    id: 'req-1',
    ok: true,
    result: {
      ok: true,
      page: {
        sessionId: SESSION_ID,
        epoch: EPOCH,
        fence: 1,
        direction: 'tail',
        items: [assistantItem(liveCursor.sequence)],
        removedItemIds: [],
        submissions: [],
        window: { oldest: liveCursor, newest: liveCursor, nextCursor: liveCursor },
        liveCursor,
        hasOlder: false,
        hasNewer: false
      }
    },
    _meta: { runtimeId: 'runtime-1' }
  }
}

describe('mobile structured agent session resume cursor', () => {
  let renderer: ReactTestRenderer | null = null
  let onEvent: ((raw: unknown) => void) | null = null
  let paramsForReconnect: (() => unknown) | null = null
  let client: RpcClient

  function Harness(props: { tick: number }): null {
    void props.tick
    useMobileStructuredAgentSession({ client, sessionId: SESSION_ID })
    return null
  }

  function resumeCursor(): AgentJournalCursor | undefined {
    return (paramsForReconnect?.() as { cursor?: AgentJournalCursor } | undefined)?.cursor
  }

  beforeEach(async () => {
    vi.useFakeTimers()
    onEvent = null
    paramsForReconnect = null
    client = {
      sendRequest: vi.fn(async () => tailResponse(cursor(10))),
      subscribe: vi.fn(
        (
          _method: string,
          _params: unknown,
          onData: (raw: unknown) => void,
          options?: SubscribeOptions
        ) => {
          onEvent = onData
          paramsForReconnect = options?.paramsForReconnect ?? null
          return () => {}
        }
      )
    } as unknown as RpcClient
    await act(async () => {
      renderer = create(createElement(Harness, { tick: 0 }))
    })
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.useRealTimers()
  })

  it('resumes from the committed reducer cursor, not the newest one the stream handler saw', async () => {
    expect(resumeCursor()).toEqual(cursor(10))

    // Received but still sitting in the coalescer: the reducer has not applied it.
    onEvent?.(batchEvent(11))
    expect(resumeCursor()).toEqual(cursor(10))

    // A re-render between the handler and the flush must not change the answer.
    await act(async () => {
      renderer?.update(createElement(Harness, { tick: 1 }))
    })
    expect(resumeCursor()).toEqual(cursor(10))

    // Once the batch is committed, the resume cursor advances with it.
    await act(async () => {
      vi.advanceTimersByTime(STRUCTURED_AGENT_SESSION_CLIENT_COALESCE_MS)
    })
    expect(resumeCursor()).toEqual(cursor(11))
  })
})
