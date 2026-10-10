import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { _internals } from '../agent-hooks/server'
import { isSubagentGroupBlock } from '../../shared/native-chat-types'
import type { AgentChildWorkView } from '../../shared/agent-status-child-work-view'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import {
  CALLER,
  envelope
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION as SESSION } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { PROVIDER_SESSION, replyChunk, waitFor } from './acp-structured-adapter.test-support'
import {
  openAttachedHostRig,
  openHostRig,
  attachParams,
  promptIdOf,
  send
} from './acp-structured-host.test-support'
import { acpChildWorkStatusSink } from './acp-structured-child-work.test-support'
import { GrokFixtureReplay } from './acp-structured-fixture-replay.test-support'
import { readAcpFixture } from './acp-timeline-fixture.test-support'

beforeEach(() => _internals.resetCachesForTests())
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) {
    await close()
  }
  await closeProviderTimelineRigs()
})

async function fixture() {
  const childWork = acpChildWorkStatusSink()
  const hosted = await openAttachedHostRig({}, childWork.sink)
  cleanup.push(() => hosted.host.close(SESSION, 'user-close'))
  const sidebar: AgentChildWorkView[][] = []
  hosted.host.subscribeStatus({
    id: 'sidebar',
    emit: (event) => {
      if (event.type === 'snapshot') {
        sidebar.push(event.sessions.flatMap((s) => s.children ?? []))
      }
      if (event.type === 'status') {
        sidebar.push(event.session.children ?? [])
      }
    }
  })
  await send(hosted.host, 'Delegate work')
  const prompt = await hosted.rig.frame('session/prompt')
  const agent = hosted.rig.child().agent
  agent.notify('session/update', replyChunk(promptIdOf(prompt), 'Delegating'))
  await hosted.rows()
  const notify = async (
    update: Record<string, unknown>,
    meta = {},
    sessionId = PROVIDER_SESSION
  ) => {
    agent.notify('_x.ai/session/update', { sessionId, update, _meta: meta })
    await hosted.rows()
  }
  const spawn = (id: string, label = 'Exact label', turn = promptIdOf(prompt)) =>
    notify({
      sessionUpdate: 'subagent_spawned',
      subagent_id: id,
      parent_prompt_id: turn,
      description: label
    })
  const finish = (id: string, status: string) =>
    notify({ sessionUpdate: 'subagent_finished', subagent_id: id, status })
  const strip = async () =>
    (await hosted.host.history({ sessionId: SESSION, direction: 'tail' })).page.backgroundTasks
  const roster = async () =>
    (await hosted.rows()).flatMap((row) =>
      row.body.kind === 'message'
        ? row.body.blocks.filter(isSubagentGroupBlock).flatMap((group) => group.agents)
        : []
    )
  const targetedStop = (taskId: string) => {
    const fields = { turnId: 'background-tasks', scope: 'background-tasks' as const, taskId }
    return hosted.host.cancel(CALLER, {
      envelope: envelope('agentSession.cancel', fields),
      ...fields
    })
  }
  return {
    ...hosted,
    childWork,
    sidebar,
    prompt,
    agent,
    notify,
    spawn,
    finish,
    strip,
    roster,
    targetedStop
  }
}

describe('Grok roster evidence through the existing host child store', () => {
  it.each([
    ['s7-subagent-foreground', 'Count note lines'],
    ['s7-subagent-background', 'List folder files']
  ])('publishes the production %s recording through the same host readers', async (name, label) => {
    const childWork = acpChildWorkStatusSink()
    const replay = new GrokFixtureReplay(await readAcpFixture(name))
    const hosted = await openHostRig({
      statusSink: childWork.sink,
      script: (agent) => replay.attach(agent)
    })
    cleanup.push(() => hosted.host.close(SESSION, 'user-close'))
    expect(await hosted.host.attach(CALLER, attachParams())).toMatchObject({ ok: true })
    const snapshots: AgentChildWorkView[][] = []
    hosted.host.subscribeStatus({
      id: 'recorded-sidebar',
      emit: (event) => {
        if (event.type === 'status') {
          snapshots.push(event.session.children ?? [])
        }
      }
    })
    await send(hosted.host, 'Recorded delegation')
    await waitFor(() => expect(replay.awaiting).toBeNull())
    await hosted.host.flushStreamedEvents(SESSION)
    expect(snapshots).toContainEqual([
      expect.objectContaining({
        kind: 'agent',
        providerId: 'subagent-1',
        description: label,
        membership: 'live'
      })
    ])
    expect(childWork.views()).toMatchObject([{ providerId: 'subagent-1', outcome: 'succeeded' }])
    expect(
      (await hosted.host.history({ sessionId: SESSION, direction: 'tail' })).page.backgroundTasks
    ).toBeNull()
  })

  it('shares exact ordinal labels between roster, agent strip and sidebar after parent completion', async () => {
    const f = await fixture()
    await f.spawn('first')
    await f.spawn('sibling')
    expect(await f.roster()).toMatchObject([{ label: 'Exact label' }, { label: 'Exact label 2' }])
    expect((await f.strip())?.tasks).toMatchObject([
      { id: 'first', kind: 'agent', description: 'Exact label' },
      { id: 'sibling', kind: 'agent', description: 'Exact label 2' }
    ])
    const stripIds = (await f.strip())?.children?.map((view) => view.id)
    expect(f.sidebar.at(-1)?.map((view) => view.id)).toEqual(stripIds)
    f.agent.reply(f.prompt, { stopReason: 'end_turn' })
    await f.rows()
    expect(f.childWork.views().map((view) => view.membership)).toEqual(['live', 'live'])
    await f.finish('first', 'completed')
    expect((await f.strip())?.tasks).toMatchObject([{ id: 'sibling' }])
    await f.finish('sibling', 'failed')
    expect(await f.strip()).toBeNull()
    expect(f.sidebar.at(-1)).toEqual([])
    expect(f.childWork.views().map((view) => view.outcome)).toEqual(['succeeded', 'failed'])
    await f.notify({ sessionUpdate: 'subagent_progress', subagent_id: 'first', tokens_used: 100 })
    expect(await f.strip()).toBeNull()
  })

  it('uses the targeted extension for one owned child and awaits its finish without cancelling parent or sibling', async () => {
    const f = await fixture()
    await f.spawn('first')
    await f.spawn('sibling')
    f.agent.on('_x.ai/subagent/cancel', (frame) => {
      expect(frame.params).toEqual({ sessionId: PROVIDER_SESSION, subagentId: 'first' })
      f.agent.reply(frame, {
        result: { subagentId: 'first', cancelled: true, outcome: { kind: 'cancelled' } }
      })
    })
    expect(await f.targetedStop('first')).toMatchObject({ ok: true, value: { cancelled: true } })
    expect(f.childWork.views().every((view) => view.membership === 'live')).toBe(true)
    expect(f.agent.frames.filter((frame) => frame.method === 'session/cancel')).toEqual([])
    await f.finish('first', 'cancelled')
    expect((await f.roster())[0].state).toBe('stopped')
    expect(f.childWork.views()).toMatchObject([
      { providerId: 'first', outcome: 'cancelled' },
      { providerId: 'sibling', membership: 'live' }
    ])
    expect((await f.strip())?.tasks).toMatchObject([{ id: 'sibling' }])
    expect(await f.targetedStop('other-parent-child')).toMatchObject({
      ok: true,
      value: { cancelled: false }
    })
    expect(f.agent.frames.filter((frame) => frame.method === '_x.ai/subagent/cancel')).toHaveLength(
      2
    )
  })

  it('reconciles an already-finished reply through the same roster and does not invent a not-found ending', async () => {
    const f = await fixture()
    await f.spawn('first')
    f.agent.on('_x.ai/subagent/cancel', (frame) =>
      f.agent.reply(frame, {
        result: {
          subagentId: 'first',
          cancelled: false,
          outcome: { kind: 'already_finished', status: 'completed' }
        }
      })
    )
    expect(await f.targetedStop('first')).toMatchObject({ ok: true, value: { cancelled: false } })
    await f.rows()
    expect((await f.roster())[0].state).toBe('completed')
    expect(f.childWork.views()).toMatchObject([{ outcome: 'succeeded' }])
    await f.spawn('missing')
    f.agent.on('_x.ai/subagent/cancel', (frame) =>
      f.agent.reply(frame, {
        result: { subagentId: 'missing', cancelled: false, outcome: { kind: 'not_found' } }
      })
    )
    expect(await f.targetedStop('missing')).toMatchObject({ ok: true, value: { cancelled: false } })
    expect(f.childWork.views().find((view) => view.providerId === 'missing')?.membership).toBe(
      'live'
    )
  })

  it('retains an original live child past 32 later groups and filters replay/wrong-session reports', async () => {
    const f = await fixture()
    await f.spawn('original')
    await f.spawn('stopped-early', 'Early stop', 'early-stop-turn')
    await f.finish('stopped-early', 'cancelled')
    await f.notify({ sessionUpdate: 'subagent_spawned', subagent_id: 'wrong' }, {}, 'other-session')
    await f.notify({ sessionUpdate: 'subagent_spawned', subagent_id: 'replay' }, { isReplay: true })
    for (let index = 0; index < 33; index++) {
      await f.spawn(`later-${index}`, `Later ${index}`, `later-turn-${index}`)
      await f.finish(`later-${index}`, 'completed')
    }
    expect((await f.strip())?.tasks).toMatchObject([{ id: 'original', description: 'Exact label' }])
    expect((await f.strip())?.tasks).toHaveLength(1)
    await f.notify({
      sessionUpdate: 'subagent_progress',
      subagent_id: 'stopped-early',
      tokens_used: 111
    })
    expect(f.childWork.views().find((view) => view.providerId === 'stopped-early')?.outcome).toBe(
      'cancelled'
    )
    await f.finish('original', 'cancelled')
    await f.spawn('eviction', 'Eviction', 'eviction-turn')
    await f.finish('eviction', 'completed')
    await f.notify({
      sessionUpdate: 'subagent_progress',
      subagent_id: 'original',
      tokens_used: 111
    })
    expect(await f.strip()).toBeNull()
    expect(f.childWork.views().find((view) => view.providerId === 'original')?.outcome).toBe(
      'cancelled'
    )
  })

  it('keeps distinct oversized provider children across groups despite identical display ids', async () => {
    const f = await fixture()
    const first = `${'x'.repeat(600)}A`
    const second = `${'x'.repeat(600)}B`
    await f.spawn(first, 'First', 'turn-A')
    await f.spawn(second, 'Second', 'turn-B')
    const entries = await f.roster()
    expect(entries[0].id).toBe(entries[1].id)
    const bothStrip = (await f.strip())?.tasks
    const bothSidebar = f.sidebar.at(-1)
    await f.finish(first, 'completed')
    const remainingStrip = (await f.strip())?.tasks
    const remainingSidebar = f.sidebar.at(-1)
    expect(await f.roster()).toMatchObject([{ state: 'completed' }, { state: 'working' }])
    expect.soft(bothStrip).toMatchObject([
      { description: 'First', kind: 'agent', stoppable: false },
      { description: 'Second', kind: 'agent', stoppable: false }
    ])
    expect.soft(bothSidebar).toHaveLength(2)
    expect.soft(remainingStrip).toMatchObject([{ description: 'Second', kind: 'agent' }])
    expect.soft(remainingSidebar).toMatchObject([{ description: 'Second', membership: 'live' }])
  })

  it('uses the exact clipped roster label and hides Stop for digested oversized provider handles', async () => {
    const f = await fixture()
    await f.spawn('long-id'.repeat(100), 'Long label '.repeat(70))
    const [entry] = await f.roster()
    expect((await f.strip())?.tasks).toMatchObject([
      { description: entry.label, kind: 'agent', stoppable: false }
    ])
    expect((await f.strip())?.tasks?.[0]?.id).toMatch(/^acp-child:[0-9a-f]{64}$/)
    expect((await f.strip())?.tasks?.[0]?.id).not.toBe(entry.id)
  })

  it('keeps 34 live groups in both host surfaces and never recreates the first settled eviction', async () => {
    const f = await fixture()
    await f.spawn('original-live', 'Original', 'original-turn')
    for (let index = 0; index < 33; index++) {
      await f.spawn(`live-${index}`, `Live ${index}`, `live-turn-${index}`)
    }
    expect((await f.strip())?.tasks).toHaveLength(34)
    expect(f.sidebar.at(-1)).toHaveLength(34)
    await f.finish('original-live', 'cancelled')
    await f.notify({
      sessionUpdate: 'subagent_progress',
      subagent_id: 'original-live',
      tokens_used: 100
    })
    expect((await f.strip())?.tasks).toHaveLength(33)
    expect(f.sidebar.at(-1)).toHaveLength(33)
    expect(f.childWork.views().find((view) => view.providerId === 'original-live')?.outcome).toBe(
      'cancelled'
    )
    expect((await f.roster()).find((entry) => entry.id === 'original-live')?.state).toBe('stopped')
  })

  it('keeps the agent strip but hides Stop when the installed peer lacks the targeted route', async () => {
    const childWork = acpChildWorkStatusSink()
    const hosted = await openHostRig({
      statusSink: childWork.sink,
      script: (agent) =>
        agent.on('_x.ai/subagent/cancel', (frame) => agent.fail(frame, -32601, 'Method not found'))
    })
    cleanup.push(() => hosted.host.close(SESSION, 'user-close'))
    expect(await hosted.host.attach(CALLER, attachParams())).toMatchObject({ ok: true })
    await send(hosted.host, 'Delegate on older peer')
    const prompt = await hosted.rig.frame('session/prompt')
    hosted.rig.child().agent.notify('_x.ai/session/update', {
      sessionId: PROVIDER_SESSION,
      update: {
        sessionUpdate: 'subagent_spawned',
        subagent_id: 'child',
        parent_prompt_id: promptIdOf(prompt),
        description: 'Exact label'
      }
    })
    await hosted.host.flushStreamedEvents(SESSION)
    const strip = (await hosted.host.history({ sessionId: SESSION, direction: 'tail' })).page
      .backgroundTasks
    expect(strip?.tasks).toMatchObject([
      { id: 'child', kind: 'agent', description: 'Exact label', stoppable: false }
    ])
    expect(strip?.supportsTaskStop).not.toBe(true)
  })

  it('settles unresolved ownership as unknown on contact loss even when the producer process remains unproven', async () => {
    const f = await fixture()
    await f.spawn('unresolved')
    const child = f.rig.child()
    child.proveClose = async () => false
    try {
      child.agent.stdout.emit('error', new Error('transport lost'))
      await f.rows()
      expect(child.exited).toBe(false)
      expect(f.childWork.views()).toMatchObject([{ membership: 'settled', outcome: 'unknown' }])
      child.agent.notify('_x.ai/session/update', {
        sessionId: PROVIDER_SESSION,
        update: { sessionUpdate: 'subagent_progress', subagent_id: 'unresolved', tokens_used: 100 }
      })
      await f.rows()
      expect(await f.strip()).toBeNull()
    } finally {
      child.exit()
    }
  })

  // Grok's own refusal means it did nothing; a reply about another subagent proves nothing, so it is unknown.
  it.each([
    ['rpc-error', { ok: false, refusal: { code: 'agent_session_operation_invalid' } }],
    ['mismatched-id', { ok: false, refusal: { code: 'agent_session_operation_unknown' } }]
  ] as const)(
    'does not settle or cancel the parent after a targeted %s',
    async (failure, answer) => {
      const f = await fixture()
      await f.spawn('first')
      await f.spawn('sibling')
      f.agent.on('_x.ai/subagent/cancel', (frame) => {
        if (failure === 'rpc-error') {
          f.agent.fail(frame, -32601, 'Method unavailable')
        } else {
          f.agent.reply(frame, { result: { subagentId: 'other', cancelled: true } })
        }
      })
      expect(await f.targetedStop('first')).toMatchObject(answer)
      expect(f.childWork.views().every((view) => view.membership === 'live')).toBe(true)
      expect(f.agent.frames.filter((frame) => frame.method === 'session/cancel')).toEqual([])
      expect(f.rig.child().closed).toBe(false)
    }
  )

  it('records a terminal first snapshot without leaving either running surface occupied', async () => {
    const f = await fixture()
    await f.finish('finished-before-spawn', 'completed')
    expect(await f.roster()).toMatchObject([{ id: 'finished-before-spawn', state: 'completed' }])
    expect(f.childWork.views()).toEqual([])
    expect(await f.strip()).toBeNull()
  })
})
