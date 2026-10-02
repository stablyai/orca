// A Stop's event and a Resume ride tombstones, but are no history: an app never receives them,
// and they never count as the content that makes a rebuilt or provider-backed epoch usable.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { projectJournalBatch } from '../agent-session-wire/agent-session-journal-batch'
import { createTrackedJournalOpener } from './journal-host-database-test-support'
import { startJournalRowFold } from './journal-open'
import { createJournalReducerState } from './journal-reducer'
import { buildJournalItemRow, journalRowBase } from './journal-row-builders'
import {
  serializeJournalRow,
  type AgentJournalEpochReason,
  type JournalRow
} from './journal-row-schema'
import {
  buildJournalQueueResumeRow,
  buildJournalStopEventRow
} from './journal-stop-and-resume-rows'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-s',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}
const EPOCH = 'epoch-1'

let root: string
const journals = createTrackedJournalOpener()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-stop-event-rows-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

/** One epoch's rows, folded as an open folds them. */
function fold(rows: readonly JournalRow[], repairedFrom: number | null = null) {
  const folding = startJournalRowFold({ sessionId: IDENTITY.sessionId, epoch: EPOCH, repairedFrom })
  for (const row of rows) {
    folding.add({ seq: row.seq, rowJson: serializeJournalRow(row) })
  }
  return folding.finish()
}

/** An epoch row, then `after` built at the next sequences. */
function epochWith(
  reason: AgentJournalEpochReason,
  after: readonly ('stop' | 'resume' | 'item')[]
): JournalRow[] {
  const state = createJournalReducerState(IDENTITY.sessionId, EPOCH)
  const rows: JournalRow[] = [
    {
      kind: 'epoch',
      reason,
      providerHandle: IDENTITY.providerHandle,
      ...journalRowBase(EPOCH, 1, 1, 1)
    }
  ]
  for (const kind of after) {
    const place = { state, seq: rows.length + 1, fence: 1, ts: rows.length + 1 }
    rows.push(
      kind === 'stop'
        ? buildJournalStopEventRow({ ...place, event: { reason: 'user-stop', at: place.ts } })
        : kind === 'resume'
          ? buildJournalQueueResumeRow(place)
          : buildJournalItemRow({
              ...place,
              identity: { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 0 },
              body: { kind: 'status', text: 'history' },
              turnScope: AGENT_JOURNAL_THREAD_SCOPE
            })
    )
  }
  return rows
}

describe("a Stop's event and a Resume", () => {
  it('never reach an app: the batch projection skips them', async () => {
    const journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
    await journal.appendItem(
      { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 0 },
      { kind: 'status', text: 'history' },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    const cursor = journal.cursor()
    await journal.appendStopEvent({ reason: 'user-stop' }, 1)
    await journal.appendQueueResume(1)
    const since = journal.readSince(cursor)
    if (!since.ok) {
      throw new Error(`expected rows, got reset ${since.reset}`)
    }
    expect(since.rows).toHaveLength(2)
    const projected = projectJournalBatch({
      rows: since.rows,
      snapshot: journal.snapshot(),
      afterSequence: cursor.sequence
    })
    expect(projected).toMatchObject({ ok: true, batch: { items: [], removedItemIds: [] } })
  })

  it('are no provider history: an unreconcilable epoch holding only them still reads corrupt', () => {
    expect(fold(epochWith('unreconcilable_prefix', ['stop', 'resume'])).corrupt).toBe(true)
    expect(fold(epochWith('unreconcilable_prefix', ['stop', 'item'])).corrupt).toBe(false)
  })

  it('are no rebuilt history: a pending repair followed only by them still reads corrupt', () => {
    expect(fold(epochWith('handle_forked', ['stop', 'resume']), 2).corrupt).toBe(true)
    expect(fold(epochWith('handle_forked', ['stop', 'item']), 2).corrupt).toBe(false)
  })
})
