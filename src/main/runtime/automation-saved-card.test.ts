import './rpc/dispatch/testing/unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Automation } from '../../shared/automations/automation-definition'
import { RpcDispatcher } from './rpc/dispatcher'
import type { OrcaRuntimeService } from './orca-runtime'
import { AUTOMATION_METHODS } from './rpc/methods/automations/automations'

const host = vi.hoisted(() => ({
  captureAgentStartDestination: vi.fn(async (sessionId: string) =>
    sessionId === 'chat-1' || sessionId === 'bot-chat' || sessionId === 'thread-1'
      ? { sessionId, epoch: 'e1', contextId: null }
      : null
  ),
  appendAgentStart: vi.fn(async (_destination: unknown, _body: unknown, _at: number) => {})
}))
vi.mock('../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => host
}))

afterEach(() => {
  host.appendAgentStart.mockClear()
})

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the card reads only these fields.
const AUTOMATION = {
  id: 'auto-1',
  name: 'Morning digest',
  enabled: true,
  nextRunAt: 2_000,
  updatedAt: 1_500,
  dtstart: 1_000,
  rrule: 'FREQ=DAILY',
  workspaceId: 'folder:fw-1',
  prompt: 'never shown',
  bot: { botId: 'bot-1', runsIn: 'chat', resultsTo: 'chat' }
} as Automation

function dispatcher() {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the methods call only these.
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    createAutomation: vi.fn(async () => AUTOMATION),
    updateAutomation: vi.fn(async () => ({ ...AUTOMATION, updatedAt: 1_600 })),
    automationOwnerPrecondition: () => undefined,
    // Only thread-1 is a Slack, Linear or GitHub thread's conversation.
    getExternalConversationSeam: () => ({
      replyTarget: (paneKey: string) => (paneKey.includes('thread-1') ? { turnId: 't' } : null)
    }),
    bots: { list: () => [{ id: 'bot-1', chatSessionId: 'bot-chat' }] }
  } as unknown as OrcaRuntimeService
  return { runtime, rpc: new RpcDispatcher({ runtime, methods: AUTOMATION_METHODS }) }
}

const CREATE = {
  name: 'Morning digest',
  prompt: 'Summarize',
  agentId: 'claude',
  bot: { botId: 'bot-1', runsIn: 'chat', resultsTo: 'chat' },
  workspaceMode: 'existing',
  rrule: 'FREQ=DAILY',
  dtstart: 1_000
}

const call = (method: string, params: unknown) => ({ id: 'r1', authToken: 't', method, params })

describe('a saved automation in the chat that saved it', () => {
  it('writes a created card into the calling chat, without the prompt', async () => {
    const { runtime, rpc } = dispatcher()
    await rpc.dispatch(call('automation.create', { ...CREATE, callerSessionId: 'chat-1' }))
    await vi.waitFor(() => expect(host.appendAgentStart).toHaveBeenCalledOnce())
    expect(host.appendAgentStart).toHaveBeenCalledWith(
      { sessionId: 'chat-1', epoch: 'e1', contextId: null },
      {
        kind: 'automation-saved',
        change: 'created',
        automation: expect.objectContaining({ id: 'auto-1', name: 'Morning digest' }),
        resultsTo: 'chat'
      },
      expect.any(Number)
    )
    expect(JSON.stringify(host.appendAgentStart.mock.calls)).not.toContain('never shown')
    expect(runtime.createAutomation).toHaveBeenCalledWith(
      expect.not.objectContaining({ callerSessionId: expect.anything() })
    )
  })

  it('writes an updated card on an edit', async () => {
    const { rpc } = dispatcher()
    await rpc.dispatch(
      call('automation.update', {
        id: 'auto-1',
        updates: { name: 'Morning digest' },
        callerSessionId: 'chat-1'
      })
    )
    await vi.waitFor(() => expect(host.appendAgentStart).toHaveBeenCalledOnce())
    expect(host.appendAgentStart.mock.calls[0]?.[1]).toMatchObject({
      change: 'updated',
      automation: { id: 'auto-1', updatedAt: 1_600 }
    })
  })

  // A Slack, Linear or GitHub-linked chat is an Orca chat: it shows its own card, and Home gets no copy.
  it("writes a thread conversation's saves only into that chat, never the bot's Chat", async () => {
    const { rpc } = dispatcher()
    await rpc.dispatch(call('automation.create', { ...CREATE, callerSessionId: 'thread-1' }))
    await rpc.dispatch(
      call('automation.update', {
        id: 'auto-1',
        updates: { name: 'x' },
        callerSessionId: 'thread-1'
      })
    )
    // A later save's card proves the thread's cards have all landed.
    await rpc.dispatch(call('automation.create', { ...CREATE, callerSessionId: 'chat-1' }))
    await vi.waitFor(() => expect(host.appendAgentStart).toHaveBeenCalledTimes(3))
    expect(host.appendAgentStart.mock.calls.map(([to, card]) => [to, card])).toEqual([
      [
        expect.objectContaining({ sessionId: 'thread-1' }),
        expect.objectContaining({ change: 'created' })
      ],
      [
        expect.objectContaining({ sessionId: 'thread-1' }),
        expect.objectContaining({ change: 'updated' })
      ],
      [
        expect.objectContaining({ sessionId: 'chat-1' }),
        expect.objectContaining({ change: 'created' })
      ]
    ])
  })

  it("writes only into the calling chat when it isn't a thread's", async () => {
    const { rpc } = dispatcher()
    await rpc.dispatch(call('automation.create', { ...CREATE, callerSessionId: 'chat-1' }))
    await vi.waitFor(() => expect(host.appendAgentStart).toHaveBeenCalledOnce())
    expect(host.appendAgentStart.mock.calls[0]?.[0]).toMatchObject({ sessionId: 'chat-1' })
  })

  it('writes nothing outside a chat, for a chat on another host, or for a paired client', async () => {
    const { runtime, rpc } = dispatcher()
    const replies = [
      await rpc.dispatch(call('automation.create', CREATE)),
      await rpc.dispatch(
        call('automation.create', { ...CREATE, callerSessionId: 'chat-elsewhere' })
      ),
      await rpc.dispatch(call('automation.create', { ...CREATE, callerSessionId: 'chat-1' }), {
        pairedDeviceId: 'phone-1'
      })
    ]
    // Each save went through; only the card was left out.
    expect(replies.map((reply) => reply.ok)).toEqual([true, true, true])
    expect(runtime.createAutomation).toHaveBeenCalledTimes(3)
    expect(host.appendAgentStart).not.toHaveBeenCalled()
  })
})
