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
  send,
  sendUnechoed,
  statusTexts,
  stop
} from './structured-agent-session-claude-stop-contract-test-actions'

async function turns() {
  await fixture.host.flushStreamedEvents(SESSION)
  return (await fixture.host.journalSnapshot(SESSION)).items.flatMap((item) => {
    const turn = readAgentJournalTurn(item.body)
    return turn ? [turn] : []
  })
}

async function precompact() {
  const connection = fixture.claude.connections[0]!
  let activity: AgentSessionTurnActivity | null = null
  await fixture.host.subscribe({
    id: 'precompact-reader',
    sessionId: SESSION,
    emit: (event) => {
      if ('activity' in event && event.activity !== undefined) {
        activity = event.activity
      }
    }
  })
  const clientMessageId = await sendUnechoed(connection)
  const written = connection.sent.at(-1)!
  // Claude Code 2.1.310: started (2 ms), init (8 ms), compacting (14 ms), echo (14,266 ms).
  frame(connection, {
    type: 'command_lifecycle',
    state: 'started',
    command_uuid: written.uuid,
    uuid: 'command-started'
  })
  frame(connection, {
    type: 'system',
    subtype: 'init',
    uuid: 'cycle-init',
    capabilities: CAPABILITIES
  })
  frame(connection, {
    type: 'system',
    subtype: 'status',
    status: 'compacting',
    uuid: 'pre-echo-compaction'
  })
  return { connection, written, clientMessageId, activity: () => activity }
}

function clearCompaction(connection: FakeConnection) {
  frame(connection, { type: 'system', subtype: 'status', status: null, uuid: 'compaction-ended' })
}

it('shows compaction before the echo and keeps one turn through the captured reply order', async () => {
  const run = await precompact()
  const [opened] = await turns()
  expect(opened).toMatchObject({
    turnId: 'pre-echo-compaction',
    state: 'running',
    userItemId: agentJournalSubmissionKey(run.clientMessageId)
  })
  expect(run.activity()).toEqual({
    turnId: opened!.turnId,
    text: 'Compacting the conversation'
  })

  clearCompaction(run.connection)
  await fixture.host.flushStreamedEvents(SESSION)
  expect(run.activity()).toBeNull()
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
  frame(run.connection, {
    type: 'command_lifecycle',
    state: 'completed',
    command_uuid: run.written.uuid
  })
  frame(run.connection, { type: 'system', subtype: 'session_state_changed', state: 'idle' })

  expect(await turns()).toEqual([
    expect.objectContaining({
      ...opened,
      state: 'completed',
      outcome: 'success',
      completedAt: expect.any(Number)
    })
  ])
  expect(run.activity()).toBeNull()
  expect(await dispatch(run.clientMessageId)).toMatchObject({ state: 'accepted' })
})

it('adopts the first echo and folds a second batched echo before any reply', async () => {
  const run = await precompact()
  const [opened] = await turns()
  expect(opened?.turnId).toBe('pre-echo-compaction')
  const second = await send('Then say FOUR.')
  await eventually(() => expect(run.connection.sent).toHaveLength(2))
  const secondWritten = run.connection.sent.at(-1)!
  clearCompaction(run.connection)
  // An init before the echo must not prevent identity-based adoption.
  frame(run.connection, { type: 'system', subtype: 'init', uuid: 'post-compact-init' })
  frame(run.connection, { ...run.written, parent_tool_use_id: null })
  frame(run.connection, { ...secondWritten, parent_tool_use_id: null })

  expect(await turns()).toEqual([opened])
  expect(await dispatch(run.clientMessageId)).toMatchObject({ state: 'accepted' })
  expect(await dispatch(second)).toMatchObject({ state: 'accepted' })
  frame(run.connection, {
    type: 'result',
    subtype: 'success',
    is_error: false,
    uuid: 'batched-result'
  })
  expect(await turns()).toEqual([
    expect.objectContaining({
      ...opened,
      state: 'completed',
      outcome: 'success',
      completedAt: expect.any(Number)
    })
  ])
})

it('interrupts one pre-echo compaction turn despite the captured late echo and cancelled lifecycle', async () => {
  const run = await precompact()
  expect(await turns()).toHaveLength(1)
  // Real auto-compaction Stop: interrupt -> status clear -> replay -> error result -> cancelled -> idle.
  fixture.claude.routes.interrupt = () => {
    clearCompaction(run.connection)
    frame(run.connection, { ...run.written, parent_tool_use_id: null })
    frame(run.connection, {
      type: 'user',
      uuid: 'interrupted-marker',
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }
    })
    frame(run.connection, INTERRUPTED_RESULT)
    frame(run.connection, {
      type: 'command_lifecycle',
      state: 'cancelled',
      command_uuid: run.written.uuid
    })
    frame(run.connection, { type: 'system', subtype: 'session_state_changed', state: 'idle' })
    return { still_queued: [], cancelled: [] }
  }
  await expect(stop()).resolves.toMatchObject({ ok: true, value: { cancelled: true } })
  await laneDrained()

  expect(await turns()).toEqual([
    expect.objectContaining({
      turnId: 'pre-echo-compaction',
      state: 'interrupted',
      outcome: 'cancellation'
    })
  ])
  expect(run.activity()).toBeNull()
  expect(await dispatch(run.clientMessageId)).toMatchObject({ state: 'accepted' })
  expect(
    (await statusTexts()).filter((text) => text.includes('may not have been delivered'))
  ).toEqual([])
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
  frame(connection, { type: 'command_lifecycle', state: 'started', command_uuid: written.uuid })
  frame(connection, { ...compacting, parent_tool_use_id: 'child-tool' })
  expect(await turns()).toEqual([])
})
