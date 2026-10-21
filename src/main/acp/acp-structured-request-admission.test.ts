// What Grok asks reaches the person only while Orca's prompt runs and may still ask: a Stop or a
// steer withdraws what is open and refuses what arrives later with Grok's own cancelled reply, with
// no card, as does a turn Grok began itself; an answer the person already gave is still sent.

import { afterEach, describe, expect, it } from 'vitest'
import {
  closeProviderTimelineRigs,
  SESSION
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import {
  openAcpAdapterRig,
  PROVIDER_SESSION,
  replyChunk,
  sendHello
} from './acp-structured-adapter.test-support'

afterEach(async () => {
  await closeProviderTimelineRigs()
})

const question = (toolCallId: string) => ({
  sessionId: PROVIDER_SESSION,
  toolCallId,
  questions: [{ question: 'Which file?', options: [{ label: 'a.ts' }, { label: 'b.ts' }] }]
})

const permission = (toolCallId: string) => ({
  sessionId: PROVIDER_SESSION,
  toolCall: { toolCallId, title: 'Write file' },
  options: [{ optionId: 'allow-once', name: 'Allow', kind: 'allow_once' }]
})

async function runningPrompt() {
  const rig = await openAcpAdapterRig()
  await rig.acquire()
  await sendHello(rig, 'first')
  await rig.frame('session/prompt')
  rig.child().agent.notify('session/update', replyChunk('prompt:first', 'working'))
  await rig.settle()
  const cards = async () =>
    (await rig.rig.rows()).filter(
      (row) => row.body.kind === 'question' || row.body.kind === 'approval'
    )
  return { rig, agent: rig.child().agent, cards }
}

describe('Grok requests and the turn they belong to', () => {
  it('shows a question while its turn runs, and withdraws it on Stop with Grok own reply', async () => {
    const { rig, agent, cards } = await runningPrompt()
    const asked = agent.request(1, 'x.ai/ask_user_question', question('call-1'))
    await rig.settle()
    expect(await cards()).toHaveLength(1)
    await rig.adapter.cancelTurn({ sessionId: SESSION, fence: 1 })
    expect(await asked).toMatchObject({ result: { outcome: 'cancelled' } })
  })

  it('withdraws an open question when a steer cancels its turn', async () => {
    const { rig, agent } = await runningPrompt()
    const asked = agent.request(6, 'x.ai/ask_user_question', question('call-6'))
    await rig.settle()
    await sendHello(rig, 'steer')
    expect(await asked).toMatchObject({ result: { outcome: 'cancelled' } })
    expect(rig.sent('session/cancel')).toHaveLength(1)
  })

  it('refuses a question that arrives after a Stop, opening no card', async () => {
    const { rig, agent, cards } = await runningPrompt()
    await rig.adapter.cancelTurn({ sessionId: SESSION, fence: 1 })
    const late = await agent.request(2, 'x.ai/ask_user_question', question('call-2'))
    expect(late).toMatchObject({ result: { outcome: 'cancelled' } })
    expect(await cards()).toEqual([])
  })

  it('refuses a permission or a question that arrives while a steer cuts the turn short', async () => {
    const { rig, agent, cards } = await runningPrompt()
    await sendHello(rig, 'steer')
    await rig.settle()
    expect(rig.sent('session/cancel')).toHaveLength(1)
    expect(
      await agent.request(3, 'session/request_permission', permission('call-3'))
    ).toMatchObject({ result: { outcome: { outcome: 'cancelled' } } })
    expect(await agent.request(4, 'x.ai/ask_user_question', question('call-4'))).toMatchObject({
      result: { outcome: 'cancelled' }
    })
    expect(await cards()).toEqual([])
  })

  it('refuses a question during a turn Grok began itself, opening no card, yet shows its plan', async () => {
    const rig = await openAcpAdapterRig()
    await rig.acquire()
    const { agent } = rig.child()
    agent.notify('session/update', replyChunk('task-completed-background-1', 'Build finished; now'))
    await rig.settle()
    expect(await agent.request(7, 'x.ai/ask_user_question', question('call-7'))).toMatchObject({
      result: { outcome: 'cancelled' }
    })
    expect(
      await agent.request(8, 'x.ai/exit_plan_mode', {
        sessionId: PROVIDER_SESSION,
        toolCallId: 'call-8',
        planContent: '# Plan'
      })
    ).toMatchObject({ result: { outcome: 'abandoned' } })
    await rig.settle()
    const rows = await rig.rig.rows()
    expect(rows.filter((row) => row.body.kind === 'question')).toEqual([])
    expect(rows.map((row) => row.body)).toContainEqual(
      expect.objectContaining({ kind: 'status', presentation: 'plan-document', text: '# Plan' })
    )
  })

  it('refuses a question when no turn is open', async () => {
    const rig = await openAcpAdapterRig()
    await rig.acquire()
    const { agent } = rig.child()
    expect(await agent.request(5, 'x.ai/ask_user_question', question('call-5'))).toMatchObject({
      result: { outcome: 'cancelled' }
    })
    expect((await rig.rig.rows()).filter((row) => row.body.kind === 'question')).toEqual([])
  })
})
