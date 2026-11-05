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
  return { connection, written, clientMessageId, activity }
}

/** Captured order after compaction: echo, boundary, summary, reply, result. */
function replyAfterCompaction(connection: FakeConnection, written: Record<string, unknown>) {
  frame(connection, { ...written, parent_tool_use_id: null })
  frame(connection, { type: 'system', subtype: 'compact_boundary', uuid: 'compact-boundary' })
  frame(connection, {
    type: 'user',
    uuid: 'compacted-context',
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'text', text: 'Conversation summary' }] }
  })
  frame(connection, {
    type: 'assistant',
    uuid: 'reply',
    parent_tool_use_id: null,
    message: { role: 'assistant', content: [{ type: 'text', text: 'THREE' }] }
  })
  frame(connection, { type: 'result', subtype: 'success', is_error: false, uuid: 'result' })
}

it.each([
  ['14 s compaction', false],
  ['zero-length compaction', true]
])(
  'shows compaction for the started send before its echo and keeps one turn, %s',
  async (_label, zeroLength) => {
    const run = await precompactAfterPriorTurn(true)
    // The previous command's late completed/idle tail opens nothing for the new send.
    expect(await turns()).toEqual([expect.objectContaining({ state: 'completed' })])

    status(run.connection, 'compacting', 'pre-echo-compaction')
    const [, opened] = await turns()
    expect(opened).toMatchObject({
      turnId: 'pre-echo-compaction',
      state: 'running',
      userItemId: agentJournalSubmissionKey(run.clientMessageId),
      requestedAt: expect.any(Number)
    })
    expect(run.activity.seen).toContainEqual({
      turnId: 'pre-echo-compaction',
      text: 'Compacting the conversation'
    })
    if (!zeroLength) {
      await fixture.host.flushStreamedEvents(SESSION)
      expect(run.activity.current()).toMatchObject({ text: 'Compacting the conversation' })
    }
    status(run.connection, null, 'compaction-ended')
    await fixture.host.flushStreamedEvents(SESSION)
    expect(run.activity.current()).toBeNull()

    replyAfterCompaction(run.connection, run.written)
    lifecycle(run.connection, 'completed', run.written.uuid)
    sessionState(run.connection, 'idle')

    const [, ...current] = await turns()
    expect(current).toEqual([
      expect.objectContaining({
        ...opened,
        state: 'completed',
        outcome: 'success',
        completedAt: expect.any(Number)
      })
    ])
    expect(run.activity.current()).toBeNull()
    expect(await dispatch(run.clientMessageId)).toEqual({ state: 'accepted', reason: null })
  }
)

it('keeps receipt-less pre-echo compaction on Working and opens the turn at the echo', async () => {
  const run = await precompactAfterPriorTurn(false)
  status(run.connection, 'compacting', 'pre-echo-compaction')
  // Without a started receipt nothing ties the compaction to this send.
  expect(await turns()).toEqual([expect.objectContaining({ state: 'completed' })])
  expect(run.activity.seen.filter(Boolean)).toEqual([])
  status(run.connection, null, 'compaction-ended')

  replyAfterCompaction(run.connection, run.written)
  sessionState(run.connection, 'idle')
  const [, ...current] = await turns()
  expect(current).toEqual([
    expect.objectContaining({
      turnId: run.written.uuid,
      state: 'completed',
      outcome: 'success',
      requestedAt: expect.any(Number)
    })
  ])
  expect(await dispatch(run.clientMessageId)).toEqual({ state: 'accepted', reason: null })
})

it.each([
  ['exact', false],
  ['reminted', true]
])(
  'releases a follow-up during pre-echo compaction and folds both echoes into one turn, %s opener echo',
  async (_label, reminted) => {
    const connection = fixture.claude.connections[0]!
    const first = await sendUnechoed(connection)
    const written = connection.sent.at(-1)!
    lifecycle(connection, 'started', written.uuid)
    status(connection, 'compacting', 'pre-echo-compaction')
    const [opened] = await turns()
    expect(opened).toMatchObject({ turnId: 'pre-echo-compaction', state: 'running' })

    // The compaction turn exists, so the follow-up is not held until the first echo.
    const second = await send('Then say FOUR.')
    await eventually(() => expect(connection.sent).toHaveLength(2))
    const secondWritten = connection.sent.at(-1)!
    status(connection, null, 'compaction-ended')
    // An init before the echoes must not prevent identity-based adoption.
    frame(connection, { type: 'system', subtype: 'init', uuid: 'post-compact-init' })
    frame(connection, {
      ...written,
      ...(reminted ? { uuid: 'reminted-opener' } : {}),
      parent_tool_use_id: null
    })
    frame(connection, { ...secondWritten, parent_tool_use_id: null })

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
  ['a Stop naming the visible turn', true]
])(
  'interrupts one pre-echo compaction turn with %s through the captured late echo and cancelled lifecycle',
  async (_label, targeted) => {
    const connection = fixture.claude.connections[0]!
    const activity = await watchActivity()
    const clientMessageId = await sendUnechoed(connection)
    const written = connection.sent.at(-1)!
    lifecycle(connection, 'started', written.uuid)
    status(connection, 'compacting', 'pre-echo-compaction')
    const [opened] = await turns()
    expect(opened?.turnId).toBe('pre-echo-compaction')
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
        turnId: 'pre-echo-compaction',
        state: 'interrupted',
        outcome: 'cancellation'
      })
    ])
    expect(activity.current()).toBeNull()
    // Delivered, not in doubt: no "may not have been delivered" return to the composer.
    expect(await dispatch(clientMessageId)).toEqual({ state: 'accepted', reason: null })
  }
)

it('ends a compaction turn Claude started then cancelled, without echo or result', async () => {
  const connection = fixture.claude.connections[0]!
  const activity = await watchActivity()
  const clientMessageId = await sendUnechoed(connection)
  const written = connection.sent.at(-1)!
  lifecycle(connection, 'started', written.uuid)
  status(connection, 'compacting', 'compaction')
  status(connection, null, 'compaction-ended')
  lifecycle(connection, 'cancelled', written.uuid)
  sessionState(connection, 'idle')
  await laneDrained()

  expect(await turns()).toEqual([
    expect.objectContaining({ turnId: 'compaction', state: 'completed' })
  ])
  expect(activity.current()).toBeNull()
  expect(await dispatch(clientMessageId)).toMatchObject({ state: 'unknown' })
})

it('opens no turn for compaction without a started send or from a child frame', async () => {
  const connection = fixture.claude.connections[0]!
  const compacting = {
    type: 'system',
    subtype: 'status',
    status: 'compacting',
    uuid: 'orphan-compaction'
  }
  frame(connection, compacting)
  await sendUnechoed(connection)
  const written = connection.sent.at(-1)!
  lifecycle(connection, 'started', written.uuid)
  frame(connection, { ...compacting, parent_tool_use_id: 'child-tool' })
  expect(await turns()).toEqual([])
})
