import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody,
  type AgentJournalTurnLifecycle
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  applyJournalRow,
  createJournalReducerState,
  renderJournalState
} from '../agent-session-journal/journal-reducer'
import { projectJournalBatch } from './agent-session-journal-batch'
import { readAgentSessionHistory } from './agent-session-history-page'
import { AgentSessionSubscribers } from './structured-agent-session-subscribers'
import { structuredAgentSessionStopNoteIdentity } from './structured-agent-session-command-turn'
import { HISTORY_PAGE_CONTENT_BUDGET_BYTES } from './agent-session-history-page-bounds'

const journals = createTrackedJournalOpener()
const turnIdentity = { provider: 'orca', clientMessageId: 'turn-1' } as const
const turnItemId = agentJournalItemKey(turnIdentity)
const noteIdentity = structuredAgentSessionStopNoteIdentity('turn-1')
const noteId = agentJournalItemKey(noteIdentity)
const scope = { kind: 'turn', turnItemId } as const
const unconfirmed: AgentJournalItemBody = {
  kind: 'status',
  ...agentSessionFailureWords(agentSessionFailureFact('cancelUnconfirmed'), { surface: 'row' }),
  tone: 'error',
  presentation: 'error'
}
const ordinary = { kind: 'status', text: 'Cancellation requested.' }
let root: string
let journal: AgentSessionJournal

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-stop-note-projection-'))
  journal = await journals.open({
    identity: {
      sessionId: 'session-1',
      workspaceId: 'ws-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: codexProviderHandle('thread-1')
    },
    stateDirectory: root
  })
})
afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

async function turn(state: AgentJournalTurnLifecycle['state'], legacy = false) {
  const lifecycle: AgentJournalTurnLifecycle = { turnId: 'turn-1', state }
  await journal.appendItem(
    turnIdentity,
    legacy
      ? { kind: 'status', text: 'Turn ended', turnLifecycle: lifecycle }
      : { kind: 'turn', ...lifecycle },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
}
async function note(body: AgentJournalItemBody = unconfirmed) {
  await journal.appendItem(noteIdentity, body, { fence: 1, turnScope: scope })
}
function readNote() {
  return journal.snapshot().items.find((item) => item.itemId === noteId)!
}
function rows() {
  const result = journal.readSince({ epoch: journal.epoch, sequence: 0 })
  if (!result.ok) {
    throw new Error(result.reset)
  }
  return result.rows
}

it.each([false, true])(
  'derives an interrupted turn note without changing any stored row (legacy=%s)',
  async (legacy) => {
    await turn('running', legacy)
    await note()
    const prior = readNote()
    const raw = journal.itemBody(noteId)
    const held = journal.cursor()
    await turn('interrupted', legacy)
    const stored = rows()
    const projected = readNote()
    expect(projected.body).toEqual(ordinary)
    expect(projected).toEqual({ ...prior, body: ordinary })
    expect(projected).not.toBe(prior)
    expect(readNote()).not.toBe(projected)
    expect(journal.itemBody(noteId)).toBe(raw)
    expect(rows()).toEqual(stored)
    expect(stored.filter((row) => row.kind === 'item' && row.itemId === noteId)).toHaveLength(1)
    const replay = createJournalReducerState('session-1', journal.epoch)
    stored.forEach((row) => applyJournalRow(replay, row))
    expect(replay.items.get(noteId)?.body).toEqual(unconfirmed)
    expect(renderJournalState(replay).items.find((item) => item.itemId === noteId)?.body).toEqual(
      ordinary
    )
    const batch = projectJournalBatch({
      rows: stored.filter((row) => row.seq > held.sequence),
      snapshot: journal.snapshot(),
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
    expect(readNote().body).toBe(journal.itemBody(noteId))
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
  await journal.appendItem({ provider: 'orca', clientMessageId: 'other' }, unconfirmed, {
    fence: 1,
    turnScope: scope
  })
  expect(readNote().body).toBe(journal.itemBody(noteId))
  expect(journal.snapshot().items.at(-1)?.body).toEqual(unconfirmed)
})

it('derives the op-keyed note after the retained association write re-keys it onto the turn', async () => {
  const op = structuredAgentSessionStopNoteIdentity('operation-1')
  await journal.appendItem(op, unconfirmed, { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE })
  await turn('running')
  const held = journal.cursor()
  await journal.appendLifecycleBatch({
    settlementId: 'stop-note-on-turn',
    fence: 1,
    mutations: [
      { kind: 'tombstone', identity: op },
      { kind: 'item', identity: noteIdentity, body: unconfirmed, turnScope: scope }
    ]
  })
  await turn('interrupted')
  expect(readNote().body).toEqual(ordinary)
  expect(journal.itemBody(noteId)).toEqual(unconfirmed)
  const batch = projectJournalBatch({
    rows: rows().filter((row) => row.seq > held.sequence),
    snapshot: journal.snapshot(),
    afterSequence: held.sequence
  })
  expect(batch).toMatchObject({ ok: true, batch: { removedItemIds: [agentJournalItemKey(op)] } })
})

it('keeps an operation note unconfirmed when no turn opened before the kill failed', async () => {
  await journal.appendItem(noteIdentity, unconfirmed, {
    fence: 1,
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
  await turn('interrupted')
  expect(readNote().body).toEqual(unconfirmed)
})

it('re-emits the note for lifecycle turn mutations and restores the raw wording for a turn tombstone', async () => {
  await turn('running')
  await note()
  const held = journal.cursor()
  await journal.appendLifecycleBatch({
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
    snapshot: journal.snapshot(),
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
  const ended = journal.cursor()
  await journal.appendLifecycleBatch({
    settlementId: 'removed',
    fence: 1,
    mutations: [{ kind: 'tombstone', identity: turnIdentity }]
  })
  const removed = projectJournalBatch({
    rows: rows().filter((row) => row.seq > ended.sequence),
    snapshot: journal.snapshot(),
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
  const held = journal.cursor()
  await turn('interrupted')
  const page = readAgentSessionHistory(journal, {
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
      window: { nextCursor: journal.cursor() },
      hasNewer: false
    }
  })
  const notePage = readAgentSessionHistory(journal, {
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
  const held = journal.cursor()
  await note()
  const forward = readAgentSessionHistory(journal, {
    sessionId: 'session-1',
    direction: 'after',
    cursor: held,
    limit: 1
  })
  expect(forward).toMatchObject({
    ok: true,
    page: {
      items: [expect.objectContaining({ itemId: noteId, body: ordinary })],
      window: { nextCursor: journal.cursor() }
    }
  })
  await journal.appendItem(
    { provider: 'orca', clientMessageId: 'later' },
    { kind: 'status', text: 'Later' },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  const backward = readAgentSessionHistory(journal, {
    sessionId: 'session-1',
    direction: 'before',
    cursor: journal.cursor(),
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

it('shrinks the triggering row window without dropping the dependent note', async () => {
  await turn('running')
  await note()
  const held = journal.cursor()
  const large = {
    kind: 'message',
    role: 'assistant',
    blocks: [
      { type: 'text', text: 'x'.repeat(Math.floor(HISTORY_PAGE_CONTENT_BUDGET_BYTES * 0.6)) }
    ]
  } as const
  for (const clientMessageId of ['large-1', 'large-2']) {
    await journal.appendItem(
      { provider: 'orca', clientMessageId },
      { ...large, blocks: [...large.blocks] },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  }
  await turn('interrupted')
  const first = readAgentSessionHistory(journal, {
    sessionId: 'session-1',
    direction: 'after',
    cursor: held,
    limit: 3
  })
  if (!first.ok) {
    throw new Error(first.reset)
  }
  expect(first.page.hasNewer).toBe(true)
  const next = readAgentSessionHistory(journal, {
    sessionId: 'session-1',
    direction: 'after',
    cursor: first.page.window.nextCursor,
    limit: 3
  })
  expect(next).toMatchObject({
    ok: true,
    page: {
      items: expect.arrayContaining([expect.objectContaining({ itemId: noteId, body: ordinary })]),
      window: { nextCursor: journal.cursor() }
    }
  })
})

it('refreshes at the exact tip using bounded frames and no durable writes', async () => {
  await turn('interrupted')
  for (let index = 0; index < 205; index += 1) {
    await journal.appendItem(structuredAgentSessionStopNoteIdentity(`op-${index}`), unconfirmed, {
      fence: 1,
      turnScope: scope
    })
  }
  const stored = rows()
  const events: AgentSessionSubscribeEvent[] = []
  new AgentSessionSubscribers().open({
    id: 'reconnect',
    sessionId: 'session-1',
    journal,
    fence: 1,
    cursor: journal.cursor(),
    emit: (event) => events.push(event)
  })
  const batches = events.flatMap((event) => (event.type === 'batch' ? [event.batch] : []))
  expect(batches.flatMap((batch) => batch.items)).toHaveLength(205)
  expect(
    batches.every(
      (batch) =>
        batch.items.length <= 200 &&
        Buffer.byteLength(JSON.stringify(batch), 'utf8') < HISTORY_PAGE_CONTENT_BUDGET_BYTES &&
        batch.cursor.sequence === journal.cursor().sequence
    )
  ).toBe(true)
  expect(
    batches
      .flatMap((batch) => batch.items)
      .every(
        (item) =>
          item.body.kind === 'status' && item.body.text === ordinary.text && !item.body.failure
      )
  ).toBe(true)
  expect(rows()).toEqual(stored)
})
