import { createElement } from 'react'
import { act, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../../src/shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../../../../src/shared/agent-session/agent-session-wire'
import { createWithQueryClient } from '../../../test-support/query-client-test-renderer'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import type { RpcResponse } from '../../../transport/rpc/rpc-wire-types'
import { useMobileStructuredAgentSession } from '../../use-mobile-structured-agent-session'
import {
  SESSION_ID,
  mutationOk,
  ok,
  snapshotEvent
} from './use-mobile-structured-agent-session-queued.test-fixture'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async () => null), setItem: vi.fn(), removeItem: vi.fn() }
}))

const row = (
  sequence: number,
  role: 'user' | 'assistant',
  text: string
): AgentJournalRenderItem => ({
  itemId: `row-${sequence}`,
  sequence,
  revision: 1,
  observedAt: sequence,
  body: { kind: 'message', role, blocks: [{ type: 'text', text }] }
})
const divider = (sequence: number): AgentJournalRenderItem => ({
  ...row(sequence, 'assistant', ''),
  body: {
    kind: 'status',
    text: 'Context cleared',
    presentation: 'context-cleared',
    contextClear: { operationId: `clear-${sequence}`, afterFence: 3, clearedAt: sequence }
  }
})
const dividerLands = (sequence: number): AgentSessionSubscribeEvent => ({
  type: 'batch',
  sessionId: SESSION_ID,
  batch: {
    cursor: { epoch: 'epoch-1', sequence },
    items: [divider(sequence)],
    removedItemIds: [],
    submissions: []
  }
})

describe('useMobileStructuredAgentSession /clear', () => {
  let renderer: ReactTestRenderer | null = null
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  async function mount() {
    let listener: ((value: unknown) => void) | null = null
    let reply: ((response: RpcResponse) => void) | null = null
    const client: Pick<RpcClient, 'sendRequest' | 'subscribe' | 'getState' | 'onStateChange'> = {
      getState: () => 'connected',
      onStateChange: () => () => {},
      sendRequest: vi.fn(async (method: string): Promise<RpcResponse> => {
        if (method === 'agentSession.options') {
          return ok({ models: [], current: {}, conversationCommands: ['clear'] })
        }
        if (method === 'agentSession.conversationCommand') {
          return new Promise((resolve) => {
            reply = resolve
          })
        }
        return ok({})
      }),
      subscribe: vi.fn((method: string, _params: unknown, onData: (value: unknown) => void) => {
        if (method === 'agentSession.subscribe') {
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
        sessionId: SESSION_ID,
        enabled: true,
        connected: true,
        hostSupport: null,
        agent: 'claude',
        onSendError: vi.fn()
      })
      return null
    }
    act(() => {
      renderer = createWithQueryClient(createElement(Harness))
    })
    await vi.waitFor(() => expect(listener).toEqual(expect.any(Function)))
    act(() =>
      listener?.(
        snapshotEvent({ items: [row(1, 'user', 'question'), row(2, 'assistant', 'reply')] })
      )
    )
    await vi.waitFor(() => expect(rendered.hook?.conversationCommands).toEqual(['clear']))
    const shown = () => ({
      text: rendered.hook!.session.messages.flatMap((message) =>
        message.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
      ),
      clearing: rendered.hook!.session.clearing
    })
    const sendClear = async () => {
      let outcome: Promise<unknown> | undefined
      act(() => {
        outcome = rendered.hook!.sendWithOutcome('/clear')
      })
      await vi.waitFor(() => expect(reply).toEqual(expect.any(Function)))
      // Wrapped so awaiting the press does not wait for the reply.
      return { outcome: outcome! }
    }
    return {
      shown,
      sendClear,
      push: (event: AgentSessionSubscribeEvent) => act(() => listener?.(event)),
      reply: async (value: unknown) => {
        await act(async () => reply?.(mutationOk(value)))
      }
    }
  }

  it('hides the old transcript from the press until the divider lands', async () => {
    const chat = await mount()
    expect(chat.shown()).toEqual({ text: ['question', 'reply'], clearing: false })

    const { outcome } = await chat.sendClear()
    expect(chat.shown()).toEqual({ text: [], clearing: true })

    // The host's reply can reach the phone before the divider it already wrote.
    await chat.reply({ command: 'clear', state: 'completed' })
    await expect(outcome).resolves.toBe('accepted')
    expect(chat.shown()).toEqual({ text: [], clearing: true })

    chat.push(dividerLands(3))
    expect(chat.shown()).toEqual({ text: ['Context cleared'], clearing: false })
  })

  it('shows the old transcript again when the host refuses the /clear', async () => {
    const chat = await mount()
    const { outcome } = await chat.sendClear()
    expect(chat.shown()).toEqual({ text: [], clearing: true })

    await chat.reply({ command: 'clear', state: 'completed', error: 'Could not clear.' })
    await expect(outcome).resolves.toBe('rejected')
    expect(chat.shown()).toEqual({ text: ['question', 'reply'], clearing: false })
  })
})
