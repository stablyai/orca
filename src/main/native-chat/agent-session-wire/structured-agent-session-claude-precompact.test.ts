import { expect, it } from 'vitest'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentSessionTurnActivity } from '../../../shared/agent-session/agent-session-wire'
import {
  claudeFrame as frame,
  type FakeConnection
} from '../../claude/structured/claude-structured-session-test-support'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'
import {
  fixture,
  CAPABILITIES,
  INTERRUPTED_RESULT,
  laneDrained
} from './structured-agent-session-claude-stop-contract-test-fixture'
import {
  dispatch,
  eventually,
  openTurn,
  send,
  sendUnechoed,
  stop
} from './structured-agent-session-claude-stop-contract-test-actions'

async function turns() {
  await fixture.host.flushStreamedEvents(SESSION)
  return (await fixture.host.journalSnapshot(SESSION)).items.flatMap((item) => {
    const turn = readAgentJournalTurn(item.body)
    return turn ? [turn] : []
  })
}

async function watchActivity() {
  const seen: (AgentSessionTurnActivity | null)[] = []
  await fixture.host.subscribe({
    id: 'precompact-reader',
    sessionId: SESSION,
    emit: (event) => {
      if ('activity' in event && event.activity !== undefined) {
        seen.push(event.activity)
      }
    }
  })
  return { seen, current: () => seen.at(-1) ?? null }
}

function status(connection: FakeConnection, value: 'compacting' | null, uuid: string) {
  frame(connection, { type: 'system', subtype: 'status', status: value, uuid })
}

function sessionState(connection: FakeConnection, state: 'idle' | 'running') {
  frame(connection, { type: 'system', subtype: 'session_state_changed', state })
}

function lifecycle(connection: FakeConnection, state: string, commandUuid: unknown) {
  frame(connection, { type: 'command_lifecycle', state, command_uuid: commandUuid })
}

/** Claude Code 2.1.310 send THREE: the handoff precedes the previous command's completed/idle tail. */
async function precompactAfterPriorTurn(withLifecycle: boolean) {
  const connection = fixture.claude.connections[0]!
  await openTurn(connection, 'Say the word TWO.')
  const prior = connection.sent.at(-1)!
  frame(connection, { type: 'result', subtype: 'success', is_error: false, uuid: 'prior-result' })
  const activity = await watchActivity()
  const clientMessageId = await sendUnechoed(connection)
  const written = connection.sent.at(-1)!
  const [, opened] = await turns()
  if (withLifecycle) {
    lifecycle(connection, 'completed', prior.uuid)
  }
  sessionState(connection, 'idle')
  sessionState(connection, 'running')
  if (withLifecycle) {
    lifecycle(connection, 'queued', written.uuid)
    lifecycle(connection, 'started', written.uuid)
  }
  frame(connection, {
    type: 'system',
    subtype: 'init',
    uuid: 'cycle-init',
    capabilities: CAPABILITIES
  })
  return { connection, written, clientMessageId, opened: opened!, activity }
}

it.each([
  ['with lifecycle receipts, 14 s compaction', true, false],
  ['without lifecycle receipts, zero-length compaction', false, true]
])(
  'owns the send from its handoff and shows compaction before the echo, %s',
  async (_label, withLifecycle, zeroLength) => {
    const run = await precompactAfterPriorTurn(withLifecycle)
    expect(run.opened).toMatchObject({
      turnId: run.written.uuid,
      state: 'running',
      userItemId: agentJournalSubmissionKey(run.clientMessageId),
      requestedAt: expect.any(Number)
    })
    // The previous command's late idle is not this run's end.
    expect((await turns()).at(-1)).toEqual(run.opened)

    status(run.connection, 'compacting', 'pre-echo-compaction')
    expect(run.activity.seen).toContainEqual({
      turnId: run.written.uuid,
      text: 'Compacting the conversation'
    })
    if (!zeroLength) {
      await fixture.host.flushStreamedEvents(SESSION)
      expect(run.activity.current()).toMatchObject({ text: 'Compacting the conversation' })
    }
    status(run.connection, null, 'compaction-ended')
    await fixture.host.flushStreamedEvents(SESSION)
    expect(run.activity.current()).toBeNull()

    frame(run.connection, { ...run.written, parent_tool_use_id: null })
    frame(run.connection, { type: 'system', subtype: 'compact_boundary', uuid: 'compact-boundary' })
    frame(run.connection, {
      type: 'user',
      uuid: 'compacted-context',
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'text', text: 'Conversation summary' }] }
    })
    frame(run.connection, {
      type: 'assistant',
      uuid: 'reply',
      parent_tool_use_id: null,
      message: { role: 'assistant', content: [{ type: 'text', text: 'THREE' }] }
    })
    frame(run.connection, { type: 'result', subtype: 'success', is_error: false, uuid: 'result' })
    if (withLifecycle) {
      lifecycle(run.connection, 'completed', run.written.uuid)
    }
    sessionState(run.connection, 'idle')

    const [, ...current] = await turns()
    expect(current).toEqual([
      expect.objectContaining({
        ...run.opened,
        state: 'completed',
        outcome: 'success',
        completedAt: expect.any(Number)
      })
    ])
    expect(run.activity.current()).toBeNull()
    expect(await dispatch(run.clientMessageId)).toEqual({ state: 'accepted', reason: null })
  }
)

it.each([
  ['exact', false],
  ['reminted', true]
])(
  'hands a follow-up over during pre-echo compaction and keeps both sends in one run, %s echo',
  async (_label, reminted) => {
    const connection = fixture.claude.connections[0]!
    const first = await sendUnechoed(connection)
    const written = connection.sent.at(-1)!
    status(connection, 'compacting', 'pre-echo-compaction')
    const [opened] = await turns()
    expect(opened).toMatchObject({ turnId: written.uuid, state: 'running' })

    // The run exists, so the follow-up is not held until the first echo.
    const second = await send('Then say FOUR.')
    await eventually(() => expect(connection.sent).toHaveLength(2))
    const secondWritten = connection.sent.at(-1)!
    status(connection, null, 'compaction-ended')
    // An init before the echoes changes the provider cycle, not the run's identity.
    frame(connection, { type: 'system', subtype: 'init', uuid: 'post-compact-init' })
    frame(connection, { ...written, parent_tool_use_id: null })
    // A joined input's echo confirms delivery into the run it joined, whatever uuid Claude gives it.
    frame(connection, {
      ...secondWritten,
      ...(reminted ? { uuid: 'reminted-follow-up' } : {}),
      parent_tool_use_id: null
    })

    expect(await turns()).toEqual([opened])
    expect(await dispatch(first)).toMatchObject({ state: 'accepted' })
    expect(await dispatch(second)).toMatchObject({ state: 'accepted' })
    frame(connection, {
      type: 'result',
      subtype: 'success',
      is_error: false,
      uuid: 'batched-result'
    })
    expect(await turns()).toEqual([
      expect.objectContaining({ ...opened, state: 'completed', outcome: 'success' })
    ])
  }
)

it.each([
  ['an untargeted Stop', false],
  ['a Stop naming the visible run', true]
])(
  'interrupts one pre-echo compaction run with %s through the captured late echo and cancelled lifecycle',
  async (_label, targeted) => {
    const connection = fixture.claude.connections[0]!
    const activity = await watchActivity()
    const clientMessageId = await sendUnechoed(connection)
    const written = connection.sent.at(-1)!
    lifecycle(connection, 'started', written.uuid)
    status(connection, 'compacting', 'pre-echo-compaction')
    const [opened] = await turns()
    // Real auto-compaction Stop: interrupt -> status clear -> replay -> error result -> cancelled -> idle.
    fixture.claude.routes.interrupt = () => {
      status(connection, null, 'compaction-ended')
      frame(connection, { ...written, parent_tool_use_id: null })
      frame(connection, {
        type: 'user',
        uuid: 'interrupted-marker',
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [{ type: 'text', text: '[Request interrupted by user]' }]
        }
      })
      frame(connection, INTERRUPTED_RESULT)
      lifecycle(connection, 'cancelled', written.uuid)
      sessionState(connection, 'idle')
      return { still_queued: [], cancelled: [] }
    }
    await expect(stop(targeted ? opened!.turnId : undefined)).resolves.toMatchObject({
      ok: true,
      value: { cancelled: true }
    })
    await laneDrained()

    expect(await turns()).toEqual([
      expect.objectContaining({
        turnId: written.uuid,
        state: 'interrupted',
        outcome: 'cancellation'
      })
    ])
    expect(activity.current()).toBeNull()
    // Delivered, not in doubt: no "may not have been delivered" return to the composer.
    expect(await dispatch(clientMessageId)).toEqual({ state: 'accepted', reason: null })
  }
)

it('gives root compaction without a send to the resumed provider and never opens from a child frame', async () => {
  const connection = fixture.claude.connections[0]!
  const compacting = {
    type: 'system',
    subtype: 'status',
    status: 'compacting',
    uuid: 'autonomous-compaction'
  }
  frame(connection, { ...compacting, parent_tool_use_id: 'child-tool' })
  expect(await turns()).toEqual([])
  frame(connection, compacting)
  expect(await turns()).toEqual([
    expect.objectContaining({ turnId: 'autonomous-compaction', state: 'running' })
  ])
})

it('ends a handed-over run that Claude started then cancelled, without init, running, echo or result', async () => {
  const connection = fixture.claude.connections[0]!
  await openTurn(connection, 'Say the word TWO.')
  frame(connection, { type: 'result', subtype: 'success', is_error: false, uuid: 'prior-result' })
  const clientMessageId = await send('Then say THREE.')
  await eventually(() => expect(connection.sent).toHaveLength(2))
  const written = connection.sent.at(-1)!
  lifecycle(connection, 'started', written.uuid)
  status(connection, 'compacting', 'compaction')
  status(connection, null, 'compaction-ended')
  lifecycle(connection, 'cancelled', written.uuid)
  sessionState(connection, 'idle')
  await laneDrained()

  expect((await turns()).map((turn) => turn.state)).toEqual(['completed', 'completed'])
  expect(await dispatch(clientMessageId)).toMatchObject({ state: 'unknown' })
})

it.each([
  ['Claude cancels it', false],
  ['a Stop cancels it', true]
])(
  'retracts an unrun send without announcing the earlier reply again when %s',
  async (_label, viaStop) => {
    const connection = fixture.claude.connections[0]!
    const completions: string[] = []
    fixture.host.subscribeTurnCompletions({
      id: 'precompact-completions',
      includePrompts: true,
      emit: (event) => {
        if (event.type === 'completion') {
          completions.push(event.completion.turnId)
        }
      }
    })
    const prior = await openTurn(connection, 'Say the word TWO.')
    frame(connection, { type: 'result', subtype: 'success', is_error: false, uuid: 'prior-result' })
    await laneDrained()
    expect(completions).toEqual([prior])

    const unrun = await sendUnechoed(connection)
    const written = connection.sent.at(-1)!
    lifecycle(connection, 'queued', written.uuid)
    if (viaStop) {
      fixture.claude.routes.interrupt = () => ({ cancelled: [written.uuid], still_queued: [] })
      await expect(stop()).resolves.toMatchObject({ ok: true, value: { cancelled: true } })
    } else {
      lifecycle(connection, 'cancelled', written.uuid)
    }
    await eventually(async () => expect(await dispatch(unrun)).toMatchObject({ state: 'rejected' }))
    await laneDrained()
    expect((await turns()).map((turn) => turn.turnId)).toEqual([prior])
    expect(completions).toEqual([prior])

    // A genuine later reply still announces, on whichever child the Stop left.
    await send('Say the word FOUR.')
    const live = await eventually(() => {
      const latest = fixture.claude.connections.at(-1)!
      expect(latest.sent.some((message) => JSON.stringify(message).includes('FOUR'))).toBe(true)
      return latest
    })
    frame(live, { ...live.sent.at(-1)!, parent_tool_use_id: null })
    frame(live, { type: 'result', subtype: 'success', is_error: false, uuid: 'next-result' })
    await eventually(() => expect(completions).toHaveLength(2))
    expect(completions[1]).not.toBe(prior)
  }
)

it.each([
  ['plural', (uuid: unknown) => ({ user_message_uuids: [uuid] })],
  ['singular', (uuid: unknown) => ({ user_message_uuid: uuid })]
])(
  'retires a follow-up its own %s result names, so it cannot anchor the next send',
  async (_label, names) => {
    const connection = fixture.claude.connections[0]!
    await openTurn(connection, 'Say the word A.')
    const uuidA = connection.sent.at(-1)!.uuid
    const followUp = await sendUnechoed(connection)
    const uuidB = connection.sent.at(-1)!.uuid
    frame(connection, {
      type: 'result',
      subtype: 'success',
      is_error: false,
      uuid: 'result-a',
      user_message_uuids: [uuidA]
    })
    // B's own result arrives with no echo, init or output of B.
    frame(connection, {
      type: 'result',
      subtype: 'success',
      is_error: false,
      uuid: 'result-b',
      ...names(uuidB)
    })
    expect(await dispatch(followUp)).toMatchObject({ state: 'accepted' })

    const next = await send('Say the word C.')
    await eventually(() => expect(connection.sent).toHaveLength(3))
    const written = connection.sent.at(-1)!
    frame(connection, { ...written, parent_tool_use_id: null })
    const running = (await turns()).filter((turn) => turn.state === 'running')
    expect(running).toEqual([
      expect.objectContaining({ turnId: written.uuid, userItemId: agentJournalSubmissionKey(next) })
    ])
    expect(connection.sent).toHaveLength(3)
  }
)
