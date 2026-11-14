import { afterEach, describe, expect, it } from 'vitest'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import {
  closeProviderTimelineRigs,
  SESSION
} from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import {
  openAcpAdapterRig,
  PROVIDER_SESSION,
  waitFor,
  type AcpAdapterRig
} from './testing/acp-structured-adapter.test-support'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'

afterEach(async () => {
  await closeProviderTimelineRigs()
})

const hello: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'hello' }]
}

function send(rig: AcpAdapterRig, clientMessageId: string) {
  return rig.adapter.dispatch({ sessionId: SESSION, clientMessageId, body: hello, fence: 1 })
}

function chunk(promptId: string, text: string) {
  return {
    sessionId: PROVIDER_SESSION,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    _meta: { promptId }
  }
}

it('reads those last words when the agent ends its stdout before its exit is seen', async () => {
  const rig = await openAcpAdapterRig({
    script: (agent) =>
      agent.on('session/new', () => {
        const child = rig.child()
        child.stderr = 'grok: config.toml is invalid'
        // Simulate stdout EOF preceding observed process exit.
        child.agent.stdout.end()
      })
  })
  const acquiring = rig.acquire()
  await rig.frame('session/new')
  await rig.settle()
  expect(rig.ended).toEqual([])
  expect(rig.child().closes).toBe(0)
  rig.child().exit()
  await acquiring
  expect(rig.ended).toMatchObject([
    { failure: { detail: { text: 'grok: config.toml is invalid' } } }
  ])
})

describe('ACP structured session adapter: turns', () => {
  it('sends a prompt under an injected id and settles it on the agent first event', async () => {
    const rig = await openAcpAdapterRig()
    await rig.acquire()
    expect(await send(rig, 'send-1')).toEqual({ state: 'admitted' })
    const prompt = await rig.frame('session/prompt')
    expect(prompt.params).toMatchObject({
      prompt: [{ type: 'text', text: 'hello' }],
      _meta: { promptId: 'prompt:send-1', requestId: 'prompt:send-1' }
    })
    rig.child().agent.notify('session/update', chunk('prompt:send-1', 'Hi there'))
    await waitFor(() =>
      expect(rig.settled).toEqual([
        {
          sessionId: SESSION,
          clientMessageId: 'send-1',
          providerIdentity: { provider: 'orca', clientMessageId: 'send-1' }
        }
      ])
    )
    rig.child().agent.reply(prompt, { stopReason: 'end_turn' })
    await waitFor(async () => {
      const turns = (await rig.rig.rows()).flatMap((row) => readAgentJournalTurn(row.body) ?? [])
      expect(turns.at(-1)).toMatchObject({ state: 'completed', outcome: 'success' })
    })
  })

  it('stops a running turn: open permissions answer cancelled, session/cancel goes out', async () => {
    const rig = await openAcpAdapterRig()
    await rig.acquire()
    await send(rig, 'send-1')
    const prompt = await rig.frame('session/prompt')
    const { agent } = rig.child()
    const permission = agent.request(7, 'session/request_permission', {
      sessionId: PROVIDER_SESSION,
      toolCall: { toolCallId: 'call-1', title: 'Write file' },
      options: [{ optionId: 'allow-once', name: 'Allow', kind: 'allow_once' }]
    })
    agent.on('session/cancel', () => agent.reply(prompt, { stopReason: 'cancelled' }))
    await rig.settle()
    await expect(rig.adapter.cancelTurn({ sessionId: SESSION, fence: 1 })).resolves.toEqual({
      cancelled: true
    })
    expect(await permission).toMatchObject({ result: { outcome: { outcome: 'cancelled' } } })
    expect(rig.sent('session/cancel')).toHaveLength(1)
    await waitFor(async () => {
      const turns = (await rig.rig.rows()).flatMap((row) => readAgentJournalTurn(row.body) ?? [])
      expect(turns.at(-1)).toMatchObject({ state: 'interrupted' })
    })
  })
})

describe('ACP structured session adapter: approvals', () => {
  it('commits the journal answer before replying with the option the person chose', async () => {
    const rig = await openAcpAdapterRig()
    await rig.acquire()
    await send(rig, 'send-1')
    await rig.frame('session/prompt')
    const { agent } = rig.child()
    const reply = agent.request(3, 'session/request_permission', {
      sessionId: PROVIDER_SESSION,
      toolCall: { toolCallId: 'call-1', title: 'Write file' },
      options: [
        { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }
      ]
    })
    const row = await waitFor(async () => {
      const found = (await rig.rig.rows()).find((item) => item.body.kind === 'approval')
      expect(found).toBeDefined()
      return found!
    })
    const order: string[] = []
    let answered = false
    void reply.then(() => {
      answered = true
      order.push('reply')
    })
    await rig.adapter.answerPrompt({
      sessionId: SESSION,
      itemId: row.itemId,
      kind: 'approval',
      response: { kind: 'option', optionId: 'reject-once' },
      fence: 1,
      commit: async () => {
        order.push('commit')
        expect(answered).toBe(false)
      }
    })
    expect(await reply).toMatchObject({
      result: { outcome: { outcome: 'selected', optionId: 'reject-once' } }
    })
    expect(order).toEqual(['commit', 'reply'])
    await expect(
      rig.adapter.answerPrompt({
        sessionId: SESSION,
        itemId: row.itemId,
        kind: 'approval',
        response: { kind: 'option', optionId: 'allow-once' },
        fence: 1,
        commit: async () => {}
      })
    ).rejects.toThrow(/no longer waiting/)
  })
})

describe('ACP structured session adapter: requests a Stop cancels', () => {
  it('sends a permission answer whose save was under way when the Stop landed', async () => {
    const rig = await openAcpAdapterRig()
    await rig.acquire()
    await send(rig, 'send-1')
    const prompt = await rig.frame('session/prompt')
    const { agent } = rig.child()
    const permission = agent.request(6, 'session/request_permission', {
      sessionId: PROVIDER_SESSION,
      toolCall: { toolCallId: 'call-1', title: 'Write file' },
      options: [{ optionId: 'allow-once', name: 'Allow', kind: 'allow_once' }]
    })
    const row = await waitFor(async () => {
      const found = (await rig.rig.rows()).find((item) => item.body.kind === 'approval')
      expect(found).toBeDefined()
      return found!
    })
    agent.on('session/cancel', () => agent.reply(prompt, { stopReason: 'cancelled' }))
    const answering = rig.adapter.answerPrompt({
      sessionId: SESSION,
      itemId: row.itemId,
      kind: 'approval',
      response: { kind: 'option', optionId: 'allow-once' },
      fence: 1,
      commit: () => rig.adapter.cancelTurn({ sessionId: SESSION, fence: 1 }).then(() => {})
    })
    // Stop must not preempt an answer already claimed for commit.
    await expect(answering).resolves.toBeUndefined()
    expect(await permission).toMatchObject({
      result: { outcome: { outcome: 'selected', optionId: 'allow-once' } }
    })
    expect(rig.sent('session/cancel')).toHaveLength(1)
  })
})

describe('ACP structured session adapter: close and exit', () => {
  it.each(['disposal', 'withdrawal'] as const)(
    'keeps failed answer commits distinct from %s',
    async (ending) => {
      const rig = await openAcpAdapterRig()
      await rig.acquire()
      const { agent } = rig.child()
      const permission = agent.request(8, 'session/request_permission', {
        sessionId: PROVIDER_SESSION,
        toolCall: { toolCallId: 'call-8', title: 'Write file' },
        options: [{ optionId: 'allow-once', name: 'Allow', kind: 'allow_once' }]
      })
      void permission.catch(() => {})
      const row = await waitFor(async () => {
        const found = (await rig.rig.rows()).find((item) => item.body.kind === 'approval')
        expect(found).toBeDefined()
        return found!
      })
      await expect(
        rig.adapter.answerPrompt({
          sessionId: SESSION,
          itemId: row.itemId,
          kind: 'approval',
          response: { kind: 'option', optionId: 'allow-once' },
          fence: 1,
          commit: async () => {
            if (ending === 'disposal') {
              await rig.adapter.closeSession(SESSION)
            } else {
              agent.notify('$/cancel_request', { requestId: 8 })
              expect(await permission).toMatchObject({
                result: { outcome: { outcome: 'cancelled' } }
              })
            }
            throw new Error('answer could not be saved')
          }
        })
      ).rejects.toThrow('answer could not be saved')
      await rig.settle()
      expect((await rig.rig.rows()).find((item) => item.itemId === row.itemId)?.body).toMatchObject(
        {
          resolution: { state: ending === 'disposal' ? 'pending' : 'cancelled' }
        }
      )
    }
  )

  it('retains a pending permission when closing its provider instead of cancelling the turn', async () => {
    const rig = await openAcpAdapterRig()
    await rig.acquire()
    await send(rig, 'send-1')
    await rig.frame('session/prompt')
    void rig
      .child()
      .agent.request(7, 'session/request_permission', {
        sessionId: PROVIDER_SESSION,
        toolCall: { toolCallId: 'call-1', title: 'Write file' },
        options: [{ optionId: 'allow-once', name: 'Allow', kind: 'allow_once' }]
      })
      .catch(() => {})
    await waitFor(async () =>
      expect(await rig.rig.rows()).toContainEqual(
        expect.objectContaining({
          body: expect.objectContaining({
            kind: 'approval',
            resolution: expect.objectContaining({ state: 'pending' })
          })
        })
      )
    )
    expect(await rig.adapter.closeSession(SESSION)).toBe(true)
    await rig.settle()
    expect(await rig.rig.rows()).toContainEqual(
      expect.objectContaining({
        body: expect.objectContaining({
          kind: 'approval',
          resolution: expect.objectContaining({ state: 'pending' })
        })
      })
    )
    expect(rig.sent('session/cancel')).toEqual([])
  })

  it('ends the session on an unexpected exit: held sends rejected, the running one unknown', async () => {
    const rig = await openAcpAdapterRig()
    await rig.acquire()
    await send(rig, 'send-1')
    await rig.frame('session/prompt')
    await send(rig, 'send-2')
    rig.child().stderr = 'grok: crashed'
    rig.child().exit()
    await waitFor(() =>
      expect(rig.ended).toMatchObject([
        {
          type: 'ended',
          cause: 'unexpected-exit',
          acquisitionGeneration: 'gen-acp',
          failure: { kind: 'providerExited' }
        }
      ])
    )
    expect(rig.settled).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ clientMessageId: 'send-2', state: 'rejected' }),
        expect.objectContaining({ clientMessageId: 'send-1', state: 'unknown' })
      ])
    )
    await expect(send(rig, 'send-3')).rejects.toThrow(/no live grok child/)
  })
})
