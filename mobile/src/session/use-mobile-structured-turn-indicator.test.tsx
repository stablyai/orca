import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../src/shared/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../../src/shared/agent-session-wire'
import type { RpcClient } from '../transport/rpc-client'
import { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'

function journalItem(
  sequence: number,
  body: AgentJournalRenderItem['body']
): AgentJournalRenderItem {
  return { itemId: `item-${sequence}`, revision: 1, sequence, observedAt: sequence, body }
}

function snapshot(items: AgentJournalRenderItem[], fence: number): AgentSessionSubscribeEvent {
  const newest = items.length
  return {
    type: 'snapshot',
    sessionId: 'session-1',
    fence,
    page: {
      sessionId: 'session-1',
      epoch: 'epoch-1',
      fence,
      direction: 'tail',
      items,
      removedItemIds: [],
      submissions: [],
      window: {
        oldest: { epoch: 'epoch-1', sequence: 1 },
        newest: { epoch: 'epoch-1', sequence: newest },
        nextCursor: { epoch: 'epoch-1', sequence: newest + 1 }
      },
      liveCursor: { epoch: 'epoch-1', sequence: newest },
      hasOlder: false,
      hasNewer: false
    }
  } as AgentSessionSubscribeEvent
}

/** What the one live indicator row reads, resolved off the session journal. */
describe('useMobileStructuredAgentSession turn indicator', () => {
  let renderer: ReactTestRenderer | null = null
  let hook: ReturnType<typeof useMobileStructuredAgentSession> | null = null
  let listener: ((value: unknown) => void) | null = null
  const sendRequest = vi.fn(async (method: string) => ({
    ok: true,
    result:
      method === 'agentSession.options'
        ? {
            models: [{ id: 'gpt-fast', label: 'GPT Fast', isDefault: true, efforts: [] }],
            current: { model: 'gpt-fast' }
          }
        : {},
    _meta: { runtimeId: 'r1' }
  }))
  const subscribe = vi.fn((_method: string, _params: unknown, onData: (value: unknown) => void) => {
    listener = onData
    return vi.fn()
  })
  const client = { sendRequest, subscribe } as unknown as RpcClient
  // Stable across renders: a fresh callback would re-run the hold/subscribe effect
  // and release the session out from under the test.
  const onSendError = vi.fn()

  function Harness(): null {
    hook = useMobileStructuredAgentSession({
      client,
      sessionId: 'session-1',
      sourceIdentity: 'host-a\0workspace-a',
      enabled: true,
      connected: true,
      agent: 'codex',
      onSendError
    } as never)
    return null
  }

  beforeEach(() => {
    vi.clearAllMocks()
    listener = null
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    hook = null
  })

  const runningTurn = journalItem(1, { kind: 'turn', turnId: 'turn-1', state: 'running' })
  const reasoning = journalItem(2, {
    kind: 'message',
    role: 'reasoning',
    blocks: [{ type: 'text', text: 'Weighing two approaches' }]
  })

  it('reads the live turn as reasoning while reasoning is its newest content', async () => {
    act(() => {
      renderer = create(createElement(Harness))
    })
    await vi.waitFor(() => expect(listener).not.toBeNull())

    act(() => {
      listener?.(snapshot([runningTurn, reasoning], 3))
    })

    expect(hook?.turnIndicator).toEqual({ thinking: true, activityText: null })
  })

  it('hands the row the provider copy once real content ends the reasoning', async () => {
    act(() => {
      renderer = create(createElement(Harness))
    })
    await vi.waitFor(() => expect(listener).not.toBeNull())

    act(() => {
      listener?.(
        snapshot(
          [
            runningTurn,
            reasoning,
            journalItem(3, {
              kind: 'tool-call',
              name: 'shell',
              input: { command: 'pnpm lint' },
              state: 'running'
            }),
            journalItem(4, { kind: 'status', text: 'Updating the plan' })
          ],
          3
        )
      )
    })

    expect(hook?.turnIndicator).toEqual({ thinking: false, activityText: 'Updating the plan' })
  })
})
