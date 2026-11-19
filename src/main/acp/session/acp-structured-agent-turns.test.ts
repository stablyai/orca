import { afterEach, describe, expect, it, vi } from 'vitest'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { isBackgroundTaskBlock } from '../../../shared/native-chat/native-chat-types'
import {
  closeProviderTimelineRigs,
  SESSION
} from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { ANTIGRAVITY_ACP_DIALECT } from '../acp-dialects/antigravity-dialect'
import type { AcpLaunchSpec } from '../launch/acp-launch-contract'
import {
  GROK,
  openAcpAdapterRig,
  PROVIDER_SESSION,
  sendHello,
  waitFor,
  type AcpAdapterRig
} from './testing/acp-structured-adapter.test-support'

afterEach(async () => {
  vi.useRealTimers()
  await closeProviderTimelineRigs()
})

// Antigravity's unprompted work after a backgrounded call (#40447), on the Grok rig's transport.
const WAKING: AcpLaunchSpec = { ...GROK, dialect: ANTIGRAVITY_ACP_DIALECT }

const update = (body: Record<string, unknown>) => ({ sessionId: PROVIDER_SESSION, update: body })
const chunk = (text: string) =>
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })

async function open(spec: AcpLaunchSpec = WAKING) {
  const clock = { now: 5_000 }
  const rig = await openAcpAdapterRig({ spec, deps: { now: () => clock.now } })
  await rig.acquire()
  return { rig, clock }
}

async function turns(rig: AcpAdapterRig) {
  return (await rig.rig.rows()).flatMap((row) => {
    const turn = readAgentJournalTurn(row.body)
    return turn ? [{ id: turn.turnId, state: turn.state }] : []
  })
}

async function agentTurns(rig: AcpAdapterRig) {
  return (await turns(rig)).filter((turn) => turn.id.includes('agent%3A'))
}

describe('Antigravity unprompted turns', () => {
  it('ends after 10s of quiet, or 120s while a call runs', async () => {
    const { rig } = await open()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    rig.child().agent.notify('session/update', chunk('done'))
    await rig.settle()
    vi.advanceTimersByTime(9_999)
    expect(await agentTurns(rig)).toMatchObject([{ state: 'running' }])
    vi.advanceTimersByTime(1)
    expect(await agentTurns(rig)).toMatchObject([{ state: 'completed' }])

    rig.child().agent.notify(
      'session/update',
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 'call-1',
        title: 'sleep 300',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { CommandLine: 'sleep 300' }
      })
    )
    await rig.settle()
    vi.advanceTimersByTime(119_999)
    expect((await agentTurns(rig)).at(-1)).toMatchObject({ state: 'running' })
    vi.advanceTimersByTime(1)
    expect((await agentTurns(rig)).at(-1)).toMatchObject({ state: 'completed' })
    const rows = await rig.rig.rows()
    expect(rows.find((row) => row.body.kind === 'tool-call')?.body).toMatchObject({
      state: 'completed'
    })
    const task = rows
      .flatMap((row) => (row.body.kind === 'message' ? row.body.blocks : []))
      .find(isBackgroundTaskBlock)
    expect(task).toMatchObject({ taskId: 'call-1', label: 'sleep 300', state: 'working' })
  })

  it('waits for the person while a request in the agent turn is open', async () => {
    const { rig } = await open()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { agent } = rig.child()
    agent.notify('session/update', chunk('May I?'))
    void agent.request(9, 'session/request_permission', {
      sessionId: PROVIDER_SESSION,
      toolCall: { toolCallId: 'call-9', title: 'rm -rf build' },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]
    })
    await rig.settle()
    vi.advanceTimersByTime(600_000)
    expect(await agentTurns(rig)).toMatchObject([{ state: 'running' }])
  })

  it('completes before a send opens the prompt turn, which no quiet timer ends', async () => {
    const { rig } = await open()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    rig.child().agent.notify('session/update', chunk('done'))
    await rig.settle()
    await sendHello(rig, 'send-1')
    await rig.settle()
    vi.advanceTimersByTime(600_000)
    const all = await turns(rig)
    expect(
      all.map((turn) => [turn.id.includes('agent%3A') ? 'agent' : 'prompt', turn.state])
    ).toEqual([
      ['agent', 'completed'],
      ['prompt', 'running']
    ])
  })

  it('ends interrupted when the person presses Stop, and late text opens no new turn', async () => {
    const { rig } = await open()
    const { agent } = rig.child()
    agent.notify('session/update', chunk('working on it'))
    await waitFor(async () => expect(await agentTurns(rig)).toMatchObject([{ state: 'running' }]))
    await rig.adapter.cancelTurn({ sessionId: SESSION, fence: 1 })
    expect(rig.sent('session/cancel')).toHaveLength(1)
    await waitFor(async () =>
      expect(await agentTurns(rig)).toMatchObject([{ state: 'interrupted' }])
    )
    agent.notify('session/update', chunk(' trailing'))
    await rig.settle()
    expect(await agentTurns(rig)).toHaveLength(1)
  })

  it('mints again once the Stop grace passes', async () => {
    const { rig, clock } = await open()
    const { agent } = rig.child()
    agent.notify('session/update', chunk('working on it'))
    await waitFor(async () => expect(await agentTurns(rig)).toHaveLength(1))
    await rig.adapter.cancelTurn({ sessionId: SESSION, fence: 1 })
    clock.now += 5_000
    agent.notify('session/update', chunk('a new report'))
    await waitFor(async () =>
      expect(await agentTurns(rig)).toMatchObject([{ state: 'interrupted' }, { state: 'running' }])
    )
  })

  it('ends an agent turn for a permission change without cancelling the agent', async () => {
    const { rig } = await open()
    rig.child().agent.notify('session/update', chunk('done'))
    await waitFor(async () => expect(await agentTurns(rig)).toHaveLength(1))
    await expect(
      rig.adapter.settlePermissionTransition({ sessionId: SESSION, fence: 1, mode: 'full-access' })
    ).resolves.toBe(true)
    expect(rig.sent('session/cancel')).toHaveLength(0)
    expect(await agentTurns(rig)).toMatchObject([{ state: 'completed' }])
  })

  it('leaves a call stopped by the person failed even when the agent answers end_turn', async () => {
    const { rig } = await open()
    await sendHello(rig, 'send-1')
    const prompt = await rig.frame('session/prompt')
    const { agent } = rig.child()
    agent.notify(
      'session/update',
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 'call-2',
        title: 'sleep 300',
        kind: 'execute',
        status: 'in_progress'
      })
    )
    agent.on('session/cancel', () => agent.reply(prompt, { stopReason: 'end_turn' }))
    await rig.settle()
    await rig.adapter.cancelTurn({ sessionId: SESSION, fence: 1 })
    await waitFor(async () => expect(await turns(rig)).toMatchObject([{ state: 'completed' }]))
    const rows = await rig.rig.rows()
    expect(rows.find((row) => row.body.kind === 'tool-call')?.body).toMatchObject({
      state: 'failed'
    })
    expect(
      rows.flatMap((row) => (row.body.kind === 'message' ? row.body.blocks : []))
    ).not.toContainEqual(expect.objectContaining({ type: 'background-task' }))
  })

  it.each([
    ['Grok', GROK],
    ['generic', { ...GROK, dialect: {} }]
  ])('leaves %s text that arrives with no prompt in thread scope', async (_name, spec) => {
    const { rig } = await open(spec)
    rig.child().agent.notify('session/update', chunk('late'))
    await rig.settle()
    expect(await turns(rig)).toEqual([])
  })
})
