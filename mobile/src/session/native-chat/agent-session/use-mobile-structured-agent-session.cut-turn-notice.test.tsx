import { createElement } from 'react'
import { snapshotEvent } from './use-mobile-structured-agent-session-queued.test-fixture'
import { act, type ReactTestRenderer } from 'react-test-renderer'
import { createWithQueryClient } from '../../../test-support/query-client-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../../src/shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../../../../src/shared/agent-session/agent-session-wire'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import type { RpcResponse } from '../../../transport/rpc/rpc-wire-types'
import { useMobileStructuredAgentSession } from '../../use-mobile-structured-agent-session'
import { ANSWERED_PROMPT_ITEMS } from '../input/mobile-native-chat-answered-prompts.test-fixture'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async () => null), setItem: vi.fn(), removeItem: vi.fn() }
}))

function snapshot(items: AgentJournalRenderItem[]): AgentSessionSubscribeEvent {
  return snapshotEvent({ items })
}

describe('useMobileStructuredAgentSession transcript', () => {
  let renderer: ReactTestRenderer | null = null
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  async function mount(agent: string, items: AgentJournalRenderItem[]) {
    let listener: ((value: unknown) => void) | null = null
    const client: Pick<RpcClient, 'sendRequest' | 'subscribe' | 'getState' | 'onStateChange'> = {
      getState: () => 'connected',
      onStateChange: () => () => {},
      sendRequest: vi.fn(async (): Promise<RpcResponse> => ({
        id: 'response-1',
        ok: true,
        result: {},
        _meta: { runtimeId: 'runtime-1' }
      })),
      subscribe: vi.fn((_method: string, _params: unknown, onData: (value: unknown) => void) => {
        if (_method === 'agentSession.subscribe') {
          listener = onData
        }
        return () => {}
      })
    }
    const rendered: { hook: ReturnType<typeof useMobileStructuredAgentSession> | null } = {
      hook: null
    }
    function Harness(): null {
      rendered.hook = useMobileStructuredAgentSession({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook's request, subscription and connection members are provided.
        client: client as RpcClient,
        pairedHostClient: null,
        sessionId: 'session-1',
        enabled: true,
        connected: true,
        hostSupport: null,
        agent,
        onSendError: vi.fn()
      })
      return null
    }
    act(() => {
      renderer = createWithQueryClient(createElement(Harness))
    })
    await vi.waitFor(() => expect(listener).toEqual(expect.any(Function)))

    act(() => listener?.(snapshot(items)))
    return rendered
  }

  it('draws an answered approval and question as receipts, never as their raw tool lines', async () => {
    const rendered = await mount('claude', ANSWERED_PROMPT_ITEMS)
    await vi.waitFor(() => expect(rendered.hook?.session.messages.length).toBeGreaterThan(0))

    const { session, receipts } = rendered.hook!
    expect(
      session.messages.some((message) =>
        message.blocks.some(
          (block) => block.type === 'tool-call' && block.name === 'AskUserQuestion'
        )
      )
    ).toBe(false)
    expect(session.messages.flatMap((message) => receipts.get(message.id)?.kind ?? [])).toEqual([
      'approval',
      'question'
    ])
  })
})
