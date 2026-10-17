import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemIdentity,
  type AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { readAgentSessionHistory } from '../agent-session-wire/agent-session-history-page'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'
import { replayJournal } from './journal-open'
import { runJournalTransaction } from './journal-database'
import { JournalPrunePass } from './journal-prune-pass'
import { renderJournalState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'

const identity: AgentSessionJournalIdentity = {
  sessionId: 'chat',
  workspaceId: 'folder-workspace',
  hostId: 'host',
  agent: 'codex',
  providerHandle: codexProviderHandle('thread')
}
const item: AgentJournalItemIdentity = {
  provider: 'codex',
  threadId: 'thread',
  turnId: 'turn',
  ordinal: 1
}
const options = { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
const journals = createTrackedJournalOpener()
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-pruning-'))
})
afterEach(async () => {
  vi.useRealTimers()
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

async function open() {
  return journals.open({ identity, stateDirectory: root })
}

function prune(epoch: string): number {
  const database = openTestJournalHostDatabase(root)
  const db = database.db
  const pass = new JournalPrunePass(db, identity.sessionId, epoch)
  let removed = 0
  for (let step = 0; step < 1_000; step++) {
    const result = pass.step(db, (run, mode) => runJournalTransaction(db, run, undefined, mode))
    removed += result.compacted
    if (result.done) {
      return removed
    }
  }
  throw new Error('pruning did not finish')
}

function rows(): JournalRow[] {
  return openTestJournalHostDatabase(root)
    .db.prepare('SELECT row_json FROM journal_rows WHERE session_id = ? ORDER BY seq')
    .all(identity.sessionId)
    .map((row) => JSON.parse(String(row.row_json)))
}

it('shrinks intermediate payloads while preserving every cursor, replay and backward history', async () => {
  const journal = await open()
  for (let revision = 1; revision <= 80; revision++) {
    await journal.appendItem(
      item,
      {
        kind: 'message',
        role: 'assistant',
        state: 'running',
        blocks: [{ type: 'text', text: 'stream '.repeat(revision) }]
      },
      options
    )
  }
  const before = journal.snapshot()
  expect(prune(journal.epoch)).toBe(78)
  expect(
    rows()
      .filter((row) => row.kind === 'item')
      .filter((row) => row.body.kind === 'message' && row.body.blocks.length > 0)
      .map((row) => row.revision)
  ).toEqual([1, 80])
  const loaded = replayJournal(openTestJournalHostDatabase(root).db, identity.sessionId)!
  expect(loaded.damage).toBeNull()
  expect(renderJournalState(loaded.state)).toEqual(before)
  const catchUp = journal.readSince({ epoch: journal.epoch, sequence: 20 })
  expect(catchUp).toMatchObject({ ok: true })
  if (catchUp.ok) {
    expect(catchUp.rows.map((row) => row.seq)).toEqual(Array.from({ length: 61 }, (_, i) => i + 21))
  }
  expect(journal.readSince({ epoch: journal.epoch, sequence: 80 })).toMatchObject({
    ok: true,
    rows: [{ seq: 81 }]
  })
  expect(
    readAgentSessionHistory(journal, {
      sessionId: identity.sessionId,
      direction: 'tail',
      limit: 1
    })
  ).toMatchObject({
    ok: true,
    page: { items: before.items, hasOlder: false }
  })
  await journal.appendItem(
    item,
    {
      kind: 'message',
      role: 'assistant',
      state: 'completed',
      blocks: [{ type: 'text', text: 'finished' }]
    },
    options
  )
  await journal.appendTombstone(item, { fence: 1 })
  expect(prune(journal.epoch)).toBe(0)
  await journal.close()
  expect((await open()).snapshot()).toEqual(journal.snapshot())
})

it('keeps turn transitions, lifecycle receipts and genuine sequence damage', async () => {
  const journal = await open()
  for (let revision = 1; revision <= 5; revision++) {
    await journal.appendItem(
      item,
      {
        kind: 'turn',
        turnId: 'turn',
        state: 'running',
        durationMs: revision,
        contextUsage: { window: { tokens: 1000, capturedAt: revision } }
      },
      options
    )
  }
  await journal.appendItem(
    { ...item, ordinal: 2 },
    {
      kind: 'message',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'in turn' }]
    },
    { fence: 1, turnScope: { kind: 'turn', turnItemId: journal.snapshot().items[0].itemId } }
  )
  for (let revision = 1; revision <= 4; revision++) {
    await journal.appendItem(
      item,
      {
        kind: 'turn',
        turnId: 'turn',
        state: 'completed',
        durationMs: revision,
        contextUsage: { window: { tokens: 1000, capturedAt: revision } }
      },
      options
    )
  }
  await journal.appendStopEvent({ reason: 'user-stop', turnId: 'turn' }, 1)
  const settlement = {
    settlementId: 'settled',
    fence: 1,
    mutations: [
      {
        kind: 'item' as const,
        itemId: 'host-note',
        body: { kind: 'status' as const, text: 'settled' },
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      }
    ]
  }
  await journal.appendLifecycleBatch(settlement)
  const before = journal.snapshot()
  expect(prune(journal.epoch)).toBe(5)
  await journal.appendLifecycleBatch(settlement)
  expect(journal.snapshot()).toEqual(before)
  expect(
    renderJournalState(
      replayJournal(openTestJournalHostDatabase(root).db, identity.sessionId)!.state
    )
  ).toEqual(before)
  const db = openTestJournalHostDatabase(root).db
  db.prepare('DELETE FROM journal_rows WHERE session_id = ? AND seq = 7').run(identity.sessionId)
  expect(replayJournal(db, identity.sessionId)?.damage).toMatchObject({
    cause: 'sequence-gap'
  })
})
