import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import { REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES } from '../../../shared/remote-runtime-memory-limits'
import { mobileE2EETextPayloadAdmissionBytes } from '../../runtime/rpc/mobile-e2ee-outbound-admission'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
import { openJournalDatabase } from '../agent-session-journal/journal-database'
import { journalDatabaseFile } from '../agent-session-journal/journal-paths'
import { insertJournalRow } from '../agent-session-journal/journal-row-table'
import type { JournalRow } from '../agent-session-journal/journal-row-schema'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-store-test-open'
import { readAgentSessionHistory } from './agent-session-history-page'
import { AgentSessionSubscribers } from './structured-agent-session-subscribers'

const SESSION = 'wire-admission-session'
const LARGE_TEXT = 'x'.repeat(250 * 1024)

let root: string
let journal: AgentSessionJournal
const journals = createTrackedJournalOpener()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-wire-admission-'))
  journal = await journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: { kind: 'codex', threadId: 'thread-1' }
    },
    journalDir: root
  })
  for (let ordinal = 1; ordinal <= 20; ordinal += 1) {
    await journal.appendItem(item(ordinal), body(`${ordinal}:${LARGE_TEXT}`), { fence: 1 })
  }
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('structured agent-session outbound admission', () => {
  it('admits bounded initial, handoff, epoch, compaction, and history recovery frames', async () => {
    expect(Buffer.byteLength(JSON.stringify(journal.snapshot()), 'utf8')).toBeGreaterThan(
      REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES
    )

    const subscribers = new AgentSessionSubscribers()
    const initial: AgentSessionSubscribeEvent[] = []
    const dispose = subscribers.open({
      id: 'initial',
      sessionId: SESSION,
      journal,
      fence: 1,
      emit: (event) => initial.push(event)
    })
    expect(initial).toHaveLength(1)
    expect(initial[0]).toMatchObject({ type: 'snapshot', page: { hasOlder: true } })
    expectAdmitted(initial[0])

    subscribers.handoff(SESSION, 2, {
      owner: 'native',
      direction: 'to-tui',
      phase: 'switching',
      stage: 'preparing',
      operationId: 'handoff-1'
    })
    subscribers.snapshot(SESSION, journal, 2)
    expect(initial.slice(1)).toHaveLength(2)
    initial.slice(1).forEach(expectAdmitted)

    const epochReset: AgentSessionSubscribeEvent[] = []
    subscribers.open({
      id: 'old-epoch',
      sessionId: SESSION,
      journal,
      fence: 2,
      cursor: { epoch: 'retired-epoch', sequence: 1 },
      emit: (event) => epochReset.push(event)
    })
    expect(epochReset[0]).toMatchObject({ type: 'reset', reset: 'epoch_changed' })
    expectAdmitted(epochReset[0])
    const epochHistory = readAgentSessionHistory(journal, {
      sessionId: SESSION,
      direction: 'before',
      cursor: { epoch: 'retired-epoch', sequence: 1 }
    })
    expect(epochHistory).toMatchObject({ ok: false, reset: 'epoch_changed' })
    expectAdmitted(epochHistory)

    // The store can no longer produce a `cursor_compacted` reset — with no row
    // shedding inside an epoch, `oldestSequence` is always 1. The reset reason
    // stays in the wire vocabulary through the over-budget page path, which is
    // where this file's subject — is such a frame admitted outbound? — now lives.
    const cursorBefore = journal.cursor()
    const overBudget = await reopenWithOversizedRemoval(cursorBefore.sequence)
    const history = readAgentSessionHistory(overBudget, {
      sessionId: SESSION,
      direction: 'after',
      cursor: cursorBefore
    })
    expect(history).toMatchObject({ ok: false, reset: 'cursor_compacted' })
    expectAdmitted(history)
    expect(initial.some((event) => event.type === 'end')).toBe(false)
    dispose()
  })

  it('splits valid-cursor catch-up into admitted batch frames', () => {
    const subscribers = new AgentSessionSubscribers()
    const catchup: AgentSessionSubscribeEvent[] = []
    const firstItemSequence = journal.snapshot().items[0]!.sequence

    subscribers.open({
      id: 'catchup',
      sessionId: SESSION,
      journal,
      fence: 2,
      cursor: { epoch: journal.epoch, sequence: firstItemSequence },
      emit: (event) => catchup.push(event)
    })

    expect(catchup.length).toBeGreaterThan(1)
    catchup.forEach(expectAdmitted)
    expect(
      catchup.flatMap((event) => (event.type === 'batch' ? event.batch.items : []))
    ).toHaveLength(19)
    expect(catchup.at(-1)).toMatchObject({
      type: 'batch',
      batch: { cursor: journal.cursor() },
      fence: 2
    })
  })
})

function expectAdmitted(value: unknown): void {
  const frame = JSON.stringify({ id: 'request-1', result: value })
  const bytes = mobileE2EETextPayloadAdmissionBytes(frame)
  expect(Number.isFinite(bytes)).toBe(true)
  expect(bytes).toBeLessThanOrEqual(REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES)
}

function item(ordinal: number): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal }
}

function body(text: string): AgentJournalItemBody {
  return { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
}

/** Stages a pre-bounding oversized removal id — the one remaining producer of a
 *  `cursor_compacted` reset — straight into the session database. */
async function reopenWithOversizedRemoval(afterSequence: number): Promise<AgentSessionJournal> {
  const hugeItemId = `codex:thread-1:${'h'.repeat(5 * 1024 * 1024)}:1`
  const base = { v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION, epoch: journal.epoch, fence: 1, ts: 1 }
  const rows: JournalRow[] = [
    {
      ...base,
      kind: 'item',
      itemId: hugeItemId,
      revision: 1,
      seq: afterSequence + 1,
      body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'big' }] }
    },
    { ...base, kind: 'tombstone', itemId: hugeItemId, revision: 2, seq: afterSequence + 2 }
  ]
  await journal.close()
  const opened = openJournalDatabase(journalDatabaseFile(root))
  try {
    opened.db.exec('BEGIN IMMEDIATE')
    for (const row of rows) {
      insertJournalRow(opened.db, SESSION, row)
    }
    opened.db.exec('COMMIT')
  } finally {
    opened.db.close()
  }
  return journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: { kind: 'codex', threadId: 'thread-1' }
    },
    journalDir: root
  })
}
