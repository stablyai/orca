import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  agentJournalTurnBody,
  readAgentJournalTurn
} from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { isBackgroundTaskBlock } from '../../../shared/native-chat/native-chat-types'
import {
  closeProviderTimelineRigs,
  SESSION
} from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { ANTIGRAVITY_ACP_DIALECT } from '../acp-dialects/antigravity-dialect'
import type { AcpLaunchSpec } from '../launch/acp-launch-contract'
import type { AgentChildWorkEvidence } from '../../../shared/agent-status/child-work/agent-status-child-work-evidence'
import { structuredAgentSessionCommandTurn } from '../../../shared/agent-session/view/structured-agent-session-command-turn-identity'
import { StructuredAgentRegistry } from '../../native-chat/agent-session-wire/providers/structured-agent-registry'
import { acpStructuredAgentDefinition } from './acp-structured-agent-definitions'
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
  const evidence: AgentChildWorkEvidence[] = []
  const journal = { refusing: false }
  const rig = await openAcpAdapterRig({
    spec,
    deps: { now: () => clock.now, onChildWorkEvidence: (_id, more) => evidence.push(...more) }
  })
  // Lets a test hold the journal backed up.
  const sink = rig.rig.eventSink
  const append = sink.tryAppendTransition?.bind(sink)
  rig.rig.eventSink = {
    ...sink,
    tryAppendTransition: (transition) =>
      journal.refusing || !append ? { accepted: false, reason: 'backpressure' } : append(transition)
  }
  await rig.acquire()
  return { rig, clock, evidence, journal }
}

const toolCall = (toolCallId: string, status: string) =>
  update({
    sessionUpdate: 'tool_call',
    toolCallId,
    title: 'npm run dev',
    kind: 'execute',
    status,
    rawInput: { CommandLine: 'npm run dev' }
  })

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
  it('ends after 20s of quiet, or 120s while a call runs', async () => {
    const { rig } = await open()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    rig.child().agent.notify('session/update', chunk('done'))
    await rig.settle()
    vi.advanceTimersByTime(19_999)
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

  it('suppresses late updates after Stop and starts a new turn after the grace period', async () => {
    const { rig, clock } = await open()
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

  it('keeps a call still running at end_turn out of live child work', async () => {
    const { rig, evidence } = await open()
    await sendHello(rig, 'send-1')
    const prompt = await rig.frame('session/prompt')
    rig.child().agent.notify('session/update', toolCall('call-3', 'in_progress'))
    await rig.settle()
    rig.child().agent.reply(prompt, { stopReason: 'end_turn' })
    await waitFor(async () => expect(await turns(rig)).toMatchObject([{ state: 'completed' }]))
    const rows = await rig.rig.rows()
    expect(
      rows.flatMap((row) => (row.body.kind === 'message' ? row.body.blocks : []))
    ).toContainEqual(expect.objectContaining({ type: 'background-task', state: 'working' }))
    expect(evidence.filter((edge) => edge.type === 'live')).toEqual([])
  })

  it('lets a send after Stop open agent turns again', async () => {
    const { rig } = await open()
    const { agent } = rig.child()
    agent.notify('session/update', chunk('working on it'))
    await waitFor(async () => expect(await agentTurns(rig)).toHaveLength(1))
    await rig.adapter.cancelTurn({ sessionId: SESSION, fence: 1 })
    await sendHello(rig, 'send-1')
    agent.reply(await rig.frame('session/prompt'), { stopReason: 'end_turn' })
    await waitFor(async () =>
      expect((await turns(rig)).at(-1)).toMatchObject({ state: 'completed' })
    )
    agent.notify('session/update', chunk('a later report'))
    await waitFor(async () =>
      expect(await agentTurns(rig)).toMatchObject([{ state: 'interrupted' }, { state: 'running' }])
    )
  })

  it('compacts after the agent turn ends even while the journal is backed up', async () => {
    const { rig, journal } = await open()
    new StructuredAgentRegistry([
      { definition: acpStructuredAgentDefinition(WAKING), adapter: rig.adapter }
    ])
    rig.child().agent.notify('session/update', chunk('done'))
    await waitFor(async () => expect(await agentTurns(rig)).toHaveLength(1))
    const turn = structuredAgentSessionCommandTurn('compact-1')
    const running = agentJournalTurnBody({
      turnId: turn.turnId,
      state: 'running',
      startedAt: 4_000
    })
    await rig.rig.journal.appendItem(turn.identity, running, {
      fence: 1,
      turnScope: { kind: 'thread' }
    })
    journal.refusing = true
    const compacting = rig.adapter.compact({
      sessionId: SESSION,
      fence: 1,
      command: { clientMessageId: 'compact-1', ...turn, running }
    })
    await rig.settle()
    journal.refusing = false
    await expect(compacting).resolves.toEqual({ state: 'accepted', providerIdentity: null })
    expect(await agentTurns(rig)).toMatchObject([{ state: 'completed' }])
  })

  it('opens no turn for a late update to a call from an older turn', async () => {
    const { rig } = await open()
    const { agent } = rig.child()
    for (const [send, events] of [
      [
        'send-1',
        [
          toolCall('call-4', 'in_progress'),
          update({ sessionUpdate: 'tool_call_update', toolCallId: 'call-4', status: 'completed' })
        ]
      ],
      ['send-2', [chunk('second')]]
    ] as const) {
      await sendHello(rig, send)
      const prompt = await rig.frame('session/prompt', send === 'send-1' ? 0 : 1)
      for (const event of events) {
        agent.notify('session/update', event)
      }
      await rig.settle()
      agent.reply(prompt, { stopReason: 'end_turn' })
      await rig.settle()
    }
    agent.notify(
      'session/update',
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'call-4', status: 'completed' })
    )
    await rig.settle()
    expect(await agentTurns(rig)).toEqual([])
  })

  it('leaves Grok text that arrives with no prompt in thread scope', async () => {
    const { rig } = await open(GROK)
    rig.child().agent.notify('session/update', chunk('late'))
    await rig.settle()
    expect(await turns(rig)).toEqual([])
  })
})
