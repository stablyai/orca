import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import {
  boundJournalKeyComponent,
  MAX_JOURNAL_KEY_COMPONENT_CHARS
} from '../../../shared/agent-session-journal-item-key'
import { loadJournal } from './journal-open'
import {
  boundInlineText,
  boundPayload,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from './journal-payload-bounds'
import { journalDatabaseFile, journalDirectoryFor, journalPathSegment } from './journal-paths'
import { AgentSessionJournalError, type AgentSessionJournal } from './journal-store'
import type { openAgentSessionJournal } from './journal-store-factory'
import { createTrackedJournalOpener } from './journal-store-test-open'
import type Database from '../../sqlite/sync-database'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}

let root: string
let clock = 1_000

function tick(): number {
  clock += 1
  return clock
}

function item(ordinal: number): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal }
}

function body(value: string): AgentJournalItemBody {
  return { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: value }] }
}

const journals = createTrackedJournalOpener()

async function open(overrides: Partial<Parameters<typeof openAgentSessionJournal>[0]> = {}) {
  return journals.open({
    identity: IDENTITY,
    journalDir: root,
    now: tick,
    mintEpoch: () => `epoch-${clock}`,
    ...overrides
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-'))
  clock = 1_000
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('sequences', () => {
  it('assigns a contiguous sequence with no gaps or reuse under concurrent appends', async () => {
    const journal = await open()
    const results = await Promise.all(
      Array.from({ length: 25 }, (_unused, index) =>
        journal.appendItem(item(index), body(`m${index}`), { fence: 1 })
      )
    )
    const sequences = results.map((result) => result.cursor.sequence)
    expect(new Set(sequences).size).toBe(25)
    expect(sequences.slice().sort((a, b) => a - b)).toEqual(
      Array.from({ length: 25 }, (_unused, index) => index + 2)
    )
  })

  it('serializes revisions of one item so the last write wins deterministically', async () => {
    const journal = await open()
    const results = await Promise.all([
      journal.appendItem(item(0), body('a'), { fence: 1 }),
      journal.appendItem(item(0), body('b'), { fence: 1 }),
      journal.appendItem(item(0), body('c'), { fence: 1 })
    ])
    expect(results.map((result) => result.revision)).toEqual([1, 2, 3])
    expect(journal.snapshot().items).toHaveLength(1)
    expect(journal.snapshot().items[0]?.revision).toBe(3)
  })

  it('preserves an oversized identity and its raw digest-form mimic across reopen', async () => {
    const oversizedTurnId = 'a'.repeat(MAX_JOURNAL_KEY_COMPONENT_CHARS + 1)
    const digestFormMimic = boundJournalKeyComponent(oversizedTurnId)
    const identityFor = (turnId: string): AgentJournalItemIdentity => ({
      provider: 'codex',
      threadId: 'thread-1',
      turnId,
      ordinal: 0
    })
    const oversizedIdentity = identityFor(oversizedTurnId)
    const mimicIdentity = identityFor(digestFormMimic)
    const journal = await open()

    const oversized = await journal.appendItem(oversizedIdentity, body('oversized'), { fence: 1 })
    const mimic = await journal.appendItem(mimicIdentity, body('mimic'), { fence: 1 })
    expect(oversized.itemId).not.toBe(mimic.itemId)
    expect([oversized.revision, mimic.revision]).toEqual([1, 1])

    const reopened = await open()
    expect(reopened.snapshot().items.map((entry) => entry.body)).toEqual([
      body('oversized'),
      body('mimic')
    ])

    await reopened.appendTombstone(oversizedIdentity, { fence: 1 })
    const afterTombstoneReopen = await open()
    expect(afterTombstoneReopen.snapshot().items.map((entry) => entry.body)).toEqual([
      body('mimic')
    ])
  })
})

describe('fences', () => {
  it('rejects an append from a writer behind the journal', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('a'), { fence: 7 })
    await expect(journal.appendItem(item(1), body('b'), { fence: 6 })).rejects.toBeInstanceOf(
      AgentSessionJournalError
    )
  })

  it('keeps accepting appends after a rejected one', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('a'), { fence: 7 })
    await journal.appendItem(item(1), body('b'), { fence: 6 }).catch(() => undefined)
    await journal.appendItem(item(2), body('c'), { fence: 7 })
    expect(journal.snapshot().items.map((entry) => entry.body)).toEqual([body('a'), body('c')])
  })
})

describe('replay', () => {
  it('adopts a caller-provided load without replaying the rows again', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('a'), { fence: 1 })
    const loaded = await loadJournal(root, IDENTITY.sessionId)
    expect(loaded).not.toBeNull()
    await journal.close()

    const reopened = await open({ loaded })
    expect(reopened.snapshot()).toEqual(journal.snapshot())
  })

  it('reopens to the same render model the live writer held', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('a'), { fence: 1 })
    await journal.appendItem(item(1), body('b'), { fence: 1 })
    await journal.appendItem(item(0), body('a2'), { fence: 1 })
    await journal.appendTombstone(item(1), { fence: 1 })
    const live = journal.snapshot()

    const reopened = await open()
    expect(reopened.snapshot()).toEqual(live)
  })

  it('serves a resume from a cursor and refuses one from a stale epoch', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('a'), { fence: 1 })
    const cursor = journal.cursor()
    await journal.appendItem(item(1), body('b'), { fence: 1 })

    const resumed = journal.readSince(cursor)
    expect(resumed.ok && resumed.rows).toHaveLength(1)

    await journal.rollEpoch('handle_forked', 2)
    expect(journal.readSince(cursor)).toEqual({ ok: false, reset: 'epoch_changed' })
  })

  it('rebuilds from a clean epoch after a rollover', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('a'), { fence: 1 })
    await journal.rollEpoch('unreconcilable_prefix', 2)
    expect(journal.snapshot().items).toHaveLength(0)

    const reopened = await open()
    expect(reopened.epoch).toBe(journal.epoch)
    expect(reopened.snapshot().items).toHaveLength(0)
  })

  it('keeps the intact prefix and drops the rejected suffix', async () => {
    const journal = await open()
    for (let index = 0; index < 4; index += 1) {
      await journal.appendItem(item(index), body(`m${index}`), { fence: 1 })
    }
    const before = journal.epoch
    await journal.close()
    await withJournalDatabase(root, (db) => {
      db.prepare('DELETE FROM journal_rows WHERE seq = ?').run(3)
    })

    const reopened = await open()
    expect(reopened.epoch).toBe(before)
    expect(reopened.snapshot().items.map((entry) => entry.body)).toEqual([body('m0')])
    // Sequences 4 and 5 are VALID rows that the gap at 3 made unreplayable.
    // Nothing preserves them; recovery rebuilds the epoch from provider history.
    await withJournalDatabase(root, (db) => {
      const rows = db.prepare('SELECT seq FROM journal_rows ORDER BY seq').all()
      expect(rows.map((row) => (row as { seq: number }).seq)).toEqual([1, 2])
    })
    expect(reopened.repair).toEqual({ malformedRows: 0 })
  })
})

describe('bounds', () => {
  it('marks a clipped payload instead of dropping bytes silently', () => {
    const limits = { ...DEFAULT_JOURNAL_PAYLOAD_LIMITS, inlineHeadBytes: 16 }
    const bounded = boundPayload('x'.repeat(4_096), limits)
    expect(bounded.truncated).toBe(true)
    expect(bounded.head).toHaveLength(16)
    expect(bounded.byteLength).toBe(4_096)
    expect(boundInlineText('x'.repeat(4_096), limits).text).toContain('output truncated')
  })

  it('never splits a multi-byte character across the bound', () => {
    const limits = { ...DEFAULT_JOURNAL_PAYLOAD_LIMITS, inlineHeadBytes: 4 }
    // Each character is three bytes, so a naive slice would land mid-sequence.
    const bounded = boundPayload('日本語テスト', limits)
    expect(bounded.head).toBe('日')
    expect(Buffer.byteLength(bounded.head, 'utf8')).toBeLessThanOrEqual(4)
  })

  it('leaves a payload inside the bound untouched', () => {
    const bounded = boundPayload('small', DEFAULT_JOURNAL_PAYLOAD_LIMITS)
    expect(bounded.truncated).toBe(false)
    expect(bounded.head).toBe('small')
    expect(boundInlineText('small', DEFAULT_JOURNAL_PAYLOAD_LIMITS).text).toBe('small')
  })
})

describe('lifecycle batches', () => {
  it('deduplicates concurrent submissions before appending a second row', async () => {
    const journal = await open()
    const input = {
      settlementId: 'concurrent-settlement',
      fence: 1,
      mutations: [{ kind: 'item' as const, identity: item(1), body: body('settled') }]
    }

    const [first, replay] = await Promise.all([
      journal.appendLifecycleBatch(input),
      journal.appendLifecycleBatch(input)
    ])

    expect([replay, first.sequence]).toEqual([first, 2])
  })

  it('applies every mutation at one sequence and deduplicates a replay across reopen', async () => {
    const journal = await open()
    const turn: AgentJournalItemIdentity = {
      provider: 'legacy',
      agent: 'codex',
      sessionId: 'session-1',
      recordId: 'turn-lifecycle:turn-1'
    }
    await journal.appendItem(turn, { kind: 'status', text: 'working' }, { fence: 1 })

    const settled = await journal.appendLifecycleBatch({
      settlementId: 'exit:turn-1',
      fence: 1,
      mutations: [
        { kind: 'item', identity: item(1), body: body('tool settled') },
        {
          kind: 'item',
          identity: { provider: 'orca', clientMessageId: 'exit-status' },
          body: { kind: 'status', text: 'Provider exited' }
        },
        { kind: 'tombstone', identity: turn }
      ]
    })
    const atSettlement = journal
      .snapshot()
      .items.filter((entry) => entry.sequence === settled.sequence)
    expect(atSettlement).toHaveLength(2)
    expect(
      journal
        .snapshot()
        .items.some((entry) => entry.body.kind === 'status' && entry.body.text === 'working')
    ).toBe(false)
    await journal.close()

    const reopened = await open()
    const beforeReplay = reopened.cursor()
    const replay = await reopened.appendLifecycleBatch({
      settlementId: 'exit:turn-1',
      fence: 1,
      mutations: [{ kind: 'item', identity: item(9), body: body('must not appear') }]
    })
    expect(replay).toEqual(beforeReplay)
    expect(
      reopened
        .snapshot()
        .items.some(
          (entry) =>
            entry.body.kind === 'message' &&
            entry.body.blocks.some(
              (block) => block.type === 'text' && block.text === 'must not appear'
            )
        )
    ).toBe(false)
  })
})

describe('journal location', () => {
  it('keys by workspace and session id rather than by a path in the working tree', () => {
    const dir = journalDirectoryFor('/state', { workspaceId: 'ws/1', sessionId: 'sess:2' })
    expect(dir).toBe(
      join(
        '/state',
        'agent-session-journal',
        journalPathSegment('ws/1'),
        journalPathSegment('sess:2')
      )
    )
    expect(dir).not.toContain('ws/1')
  })

  it('separates two sessions in one workspace', () => {
    const a = journalDirectoryFor('/state', { workspaceId: 'ws', sessionId: 'a' })
    const b = journalDirectoryFor('/state', { workspaceId: 'ws', sessionId: 'b' })
    expect(a).not.toBe(b)
  })
})

describe('on-disk layout', () => {
  it('keeps the session database and its projection in one directory', async () => {
    const journal: AgentSessionJournal = await open()
    await journal.appendItem(item(0), body('a'), { fence: 1 })
    expect(await readdir(root)).toContain('journal.db')
    await journal.close()
    await withJournalDatabase(root, (db) => {
      const row = db.prepare('SELECT row_json FROM journal_rows WHERE seq = 2').get()
      expect((row as { row_json: string }).row_json).toContain('"kind":"item"')
      expect(db.prepare('SELECT epoch FROM journal_sessions').get()).toMatchObject({
        epoch: journal.epoch
      })
    })
  })
})

/** Opens the session database directly, so a case can stage a fault or read
 *  back what a commit actually stored. */
async function withJournalDatabase(
  journalDir: string,
  run: (db: Database.Database) => void
): Promise<void> {
  const { openJournalDatabase } = await import('./journal-database')
  const opened = openJournalDatabase(journalDatabaseFile(journalDir))
  try {
    run(opened.db)
  } finally {
    opened.db.close()
  }
}
