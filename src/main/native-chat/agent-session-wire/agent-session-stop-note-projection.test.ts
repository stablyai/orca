import { expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody
} from '../../../shared/agent-session-journal-types'
import { restoreJournal } from '../agent-session-journal/journal-open'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { renderJournalState } from '../agent-session-journal/journal-reducer'
import { projectJournalBatch } from './agent-session-journal-batch'
import { readAgentSessionHistory } from './agent-session-history-page'
import { structuredAgentSessionStopNoteIdentity } from './structured-agent-session-command-turn'

import {
  fixture,
  note,
  noteId,
  noteIdentity,
  ordinary,
  readNote,
  rows,
  scope,
  turn,
  turnIdentity,
  turnItemId,
  unconfirmed
} from './agent-session-stop-note-contract-test-fixture'

it.each([false, true])(
  'derives an interrupted turn note without changing any stored row (legacy=%s)',
  async (legacy) => {
    await turn('running', legacy)
    await note()
    const prior = readNote()
    const raw = fixture.journal.itemBody(noteId)
    const held = fixture.journal.cursor()
    await turn('interrupted', legacy)
    const stored = rows()
    const projected = readNote()
    expect(projected.body).toEqual(ordinary)
    expect(projected).toEqual({ ...prior, body: ordinary })
    expect(projected).not.toBe(prior)
    expect(readNote()).toBe(projected)
    expect(fixture.journal.itemBody(noteId)).toBe(raw)
    expect(rows()).toEqual(stored)
    expect(
      stored.filter((row) => row.kind === 'outcome' && row.itemIds.includes(noteId))
    ).toHaveLength(1)
    const replay = restoreJournal(openTestJournalHostDatabase(fixture.root).db, 'session-1')!.state
    expect(replay.items.get(noteId)?.body).toEqual(unconfirmed)
    expect(renderJournalState(replay).items.find((item) => item.itemId === noteId)?.body).toEqual(
      ordinary
    )
    const batch = projectJournalBatch({
      rows: stored.filter((row) => row.seq > held.sequence),
      snapshot: fixture.journal.snapshot(),
      afterSequence: held.sequence
    })
    expect(batch).toMatchObject({
      ok: true,
      batch: {
        items: [
          expect.objectContaining({ itemId: turnItemId }),
          expect.objectContaining({ itemId: noteId, body: ordinary })
        ],
        removedItemIds: []
      }
    })
  }
)

it.each(['running', 'completed', 'unverifiable', 'missing'] as const)(
  'leaves a %s turn note unchanged',
  async (state) => {
    if (state !== 'missing') {
      await turn(state)
    }
    await note()
    expect(readNote().body).toBe(fixture.journal.itemBody(noteId))
    expect(readNote().body).toEqual(unconfirmed)
  }
)

it('leaves unrelated failures and non-Stop notes unchanged', async () => {
  await turn('interrupted')
  const failed: AgentJournalItemBody = {
    kind: 'status',
    ...agentSessionFailureWords(agentSessionFailureFact('providerExited'), { surface: 'row' })
  }
  await note(failed)
  await fixture.journal.appendItem({ provider: 'orca', clientMessageId: 'other' }, unconfirmed, {
    fence: 1,
    turnScope: scope
  })
  expect(readNote().body).toBe(fixture.journal.itemBody(noteId))
  expect(fixture.journal.snapshot().items.at(-1)?.body).toEqual(unconfirmed)
})

it('derives the op-keyed note after the retained association write re-keys it onto the turn', async () => {
  const op = structuredAgentSessionStopNoteIdentity('operation-1')
  await fixture.journal.appendItem(op, unconfirmed, {
    fence: 1,
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
  await turn('running')
  const held = fixture.journal.cursor()
  await fixture.journal.appendLifecycleBatch({
    settlementId: 'stop-note-on-turn',
    fence: 1,
    mutations: [
      { kind: 'tombstone', identity: op },
      { kind: 'item', identity: noteIdentity, body: unconfirmed, turnScope: scope }
    ]
  })
  await turn('interrupted')
  expect(readNote().body).toEqual(ordinary)
  expect(fixture.journal.itemBody(noteId)).toEqual(unconfirmed)
  const batch = projectJournalBatch({
    rows: rows().filter((row) => row.seq > held.sequence),
    snapshot: fixture.journal.snapshot(),
    afterSequence: held.sequence
  })
  expect(batch).toMatchObject({ ok: true, batch: { removedItemIds: [agentJournalItemKey(op)] } })
})

it('keeps an operation note unconfirmed when no turn opened before the kill failed', async () => {
  await fixture.journal.appendItem(noteIdentity, unconfirmed, {
    fence: 1,
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
  await turn('interrupted')
  expect(readNote().body).toEqual(unconfirmed)
})

it('re-emits the note for lifecycle turn mutations and restores the raw wording for a turn tombstone', async () => {
  await turn('running')
  await note()
  const held = fixture.journal.cursor()
  await fixture.journal.appendLifecycleBatch({
    settlementId: 'ended',
    fence: 1,
    mutations: [
      {
        kind: 'item',
        identity: turnIdentity,
        body: { kind: 'turn', turnId: 'turn-1', state: 'interrupted' },
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      }
    ]
  })
  const batch = projectJournalBatch({
    rows: rows().filter((row) => row.seq > held.sequence),
    snapshot: fixture.journal.snapshot(),
    afterSequence: held.sequence
  })
  expect(batch).toMatchObject({
    ok: true,
    batch: {
      items: [
        expect.objectContaining({ itemId: turnItemId }),
        expect.objectContaining({ itemId: noteId, body: ordinary })
      ]
    }
  })
  const ended = fixture.journal.cursor()
  await fixture.journal.appendLifecycleBatch({
    settlementId: 'removed',
    fence: 1,
    mutations: [{ kind: 'tombstone', identity: turnIdentity }]
  })
  const removed = projectJournalBatch({
    rows: rows().filter((row) => row.seq > ended.sequence),
    snapshot: fixture.journal.snapshot(),
    afterSequence: ended.sequence
  })
  expect(removed).toMatchObject({
    ok: true,
    batch: {
      items: [expect.objectContaining({ itemId: noteId, body: unconfirmed })],
      removedItemIds: [turnItemId]
    }
  })
})

it('pages the end with its earlier note and advances by the consumed end row', async () => {
  await turn('running')
  await note()
  const held = fixture.journal.cursor()
  await turn('interrupted')
  const page = readAgentSessionHistory(fixture.journal, {
    sessionId: 'session-1',
    direction: 'after',
    cursor: held,
    limit: 1
  })
  expect(page).toMatchObject({
    ok: true,
    page: {
      items: [
        expect.objectContaining({ itemId: turnItemId }),
        expect.objectContaining({ itemId: noteId, body: ordinary })
      ],
      window: { nextCursor: fixture.journal.cursor() },
      hasNewer: false
    }
  })
  const notePage = readAgentSessionHistory(fixture.journal, {
    sessionId: 'session-1',
    direction: 'tail',
    limit: 1
  })
  expect(notePage).toMatchObject({
    ok: true,
    page: { items: [expect.objectContaining({ itemId: noteId, body: ordinary })] }
  })
})

it('derives a note page with its ended turn on an earlier page, in either paging direction', async () => {
  await turn('interrupted')
  const held = fixture.journal.cursor()
  await note()
  const forward = readAgentSessionHistory(fixture.journal, {
    sessionId: 'session-1',
    direction: 'after',
    cursor: held,
    limit: 1
  })
  expect(forward).toMatchObject({
    ok: true,
    page: {
      items: [expect.objectContaining({ itemId: noteId, body: ordinary })],
      window: { nextCursor: fixture.journal.cursor() }
    }
  })
  await fixture.journal.appendItem(
    { provider: 'orca', clientMessageId: 'later' },
    { kind: 'status', text: 'Later' },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  const backward = readAgentSessionHistory(fixture.journal, {
    sessionId: 'session-1',
    direction: 'before',
    cursor: fixture.journal.cursor(),
    limit: 1
  })
  expect(backward).toMatchObject({
    ok: true,
    page: {
      items: [expect.objectContaining({ itemId: noteId, body: ordinary })],
      window: { nextCursor: { sequence: readNote().sequence } }
    }
  })
})
