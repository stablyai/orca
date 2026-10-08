import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
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
  agentJournalItemKey,
  boundJournalKeyComponent,
  MAX_JOURNAL_KEY_COMPONENT_CHARS
} from '../../../shared/agent-session-journal-item-key'
import {
  boundInlineText,
  boundPayload,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from './journal-payload-bounds'
import { activeStructuredAgentSessionTurnId } from '../../../shared/structured-agent-session-live-turn'
import { AgentSessionJournalError, type AgentSessionJournal } from './journal-store'
import type { openAgentSessionJournal } from './journal-store-factory'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase,
  liveTestJournalRows,
  deleteTestJournalRow
} from './journal-host-database-test-support'
import type Database from '../../sqlite/sync-database'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: codexProviderHandle('thread-1')
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
    stateDirectory: root,
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
        journal.appendItem(item(index), body(`m${index}`), {
          fence: 1,
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        })
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
      journal.appendItem(item(0), body('a'), { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }),
      journal.appendItem(item(0), body('b'), { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }),
      journal.appendItem(item(0), body('c'), { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE })
    ])
    expect(results.map((result) => result.revision)).toEqual([1, 2, 3])
    expect(journal.snapshot().items).toHaveLength(1)
    expect(journal.snapshot().items[0]?.revision).toBe(3)
  })

  it('visits reduced items at their creation sequence without promoting an older revision', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('first'), {
      fence: 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    const latest = await journal.appendItem(item(1), body('second'), {
      fence: 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    await journal.appendItem(item(0), body('first revised'), {
      fence: 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    const visited: { itemId: string; sequence: number }[] = []

    journal.visitItems((itemId, sequence) => visited.push({ itemId, sequence }))

    expect(visited).toEqual([
      { itemId: agentJournalItemKey(item(0)), sequence: 2 },
      { itemId: latest.itemId, sequence: latest.cursor.sequence }
    ])
  })

  it('reads the live turn off reduced items, agreeing with the rendered snapshot', async () => {
    const journal = await open()
    const turnItem = (turnId: string): AgentJournalItemIdentity => ({
      provider: 'legacy',
      agent: 'codex',
      sessionId: 'session-1',
      recordId: `turn-lifecycle:${turnId}`
    })
    const rendered = (): string | null =>
      activeStructuredAgentSessionTurnId(journal.snapshot().items)
    const bothAgreeOn = async (turnId: string | null): Promise<void> => {
      expect(journal.activeTurnId()).toBe(turnId)
      expect(rendered()).toBe(turnId)
    }

    await journal.appendItem(
      turnItem('turn-1'),
      { kind: 'turn', turnId: 'turn-1', state: 'running' },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await journal.appendItem(item(0), body('work'), {
      fence: 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    await bothAgreeOn('turn-1')

    // The completion is a revision, so it keeps the row's creation sequence rather than moving it.
    await journal.appendItem(
      turnItem('turn-1'),
      { kind: 'turn', turnId: 'turn-1', state: 'completed' },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await bothAgreeOn(null)

    await journal.appendItem(
      turnItem('turn-2'),
      { kind: 'turn', turnId: 'turn-2', state: 'running' },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await bothAgreeOn('turn-2')
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

    const oversized = await journal.appendItem(oversizedIdentity, body('oversized'), {
      fence: 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    const mimic = await journal.appendItem(mimicIdentity, body('mimic'), {
      fence: 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
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
    await journal.appendItem(item(0), body('a'), {
      fence: 7,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    await expect(
      journal.appendItem(item(1), body('b'), { fence: 6, turnScope: AGENT_JOURNAL_THREAD_SCOPE })
    ).rejects.toBeInstanceOf(AgentSessionJournalError)
  })

  it('keeps accepting appends after a rejected one', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('a'), {
      fence: 7,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    await journal
      .appendItem(item(1), body('b'), { fence: 6, turnScope: AGENT_JOURNAL_THREAD_SCOPE })
      .catch(() => undefined)
    await journal.appendItem(item(2), body('c'), {
      fence: 7,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    expect(journal.snapshot().items.map((entry) => entry.body)).toEqual([body('a'), body('c')])
  })
})

describe('replay', () => {
  it('reopens to the same render model the live writer held', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('a'), {
      fence: 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    await journal.appendItem(item(1), body('b'), {
      fence: 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    await journal.appendItem(item(0), body('a2'), {
      fence: 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    await journal.appendTombstone(item(1), { fence: 1 })
    const live = journal.snapshot()

    const reopened = await open()
    expect(reopened.snapshot()).toEqual(live)
  })

  it('serves a resume from a cursor and refuses one from a stale epoch', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('a'), {
      fence: 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    const cursor = journal.cursor()
    await journal.appendItem(item(1), body('b'), {
      fence: 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })

    const resumed = journal.readSince(cursor)
    expect(resumed.ok && resumed.rows).toHaveLength(1)

    await journal.rollEpoch('handle_forked', 2)
    expect(journal.readSince(cursor)).toEqual({ ok: false, reset: 'epoch_changed' })
  })

  it('rebuilds from a clean epoch after a rollover', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('a'), {
      fence: 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    await journal.rollEpoch('unreconcilable_prefix', 2)
    expect(journal.snapshot().items).toHaveLength(0)

    const reopened = await open()
    expect(reopened.epoch).toBe(journal.epoch)
    expect(reopened.snapshot().items).toHaveLength(0)
  })

  it('refuses a journal with a gap and keeps every row', async () => {
    const journal = await open()
    for (let index = 0; index < 4; index += 1) {
      await journal.appendItem(item(index), body(`m${index}`), {
        fence: 1,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
    }
    await journal.close()
    await withJournalDatabase(root, (db) => {
      deleteTestJournalRow(db, IDENTITY.sessionId, 3)
    })

    await expect(open()).rejects.toMatchObject({
      refusal: { details: { reason: 'journalCorrupt' } }
    })
    await withJournalDatabase(root, (db) => {
      const rows = liveTestJournalRows(db, IDENTITY.sessionId)
      expect(rows.map((row) => row.seq)).toEqual([1, 2, 4, 5])
    })
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
      mutations: [
        {
          kind: 'item' as const,
          identity: item(1),
          body: body('settled'),
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        }
      ]
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
    await journal.appendItem(
      turn,
      { kind: 'status', text: 'working' },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )

    const settled = await journal.appendLifecycleBatch({
      settlementId: 'exit:turn-1',
      fence: 1,
      mutations: [
        {
          kind: 'item',
          identity: item(1),
          body: body('tool settled'),
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        },
        {
          kind: 'item',
          identity: { provider: 'orca', clientMessageId: 'exit-status' },
          body: { kind: 'status', text: 'Provider exited' },
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
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
      mutations: [
        {
          kind: 'item',
          identity: item(9),
          body: body('must not appear'),
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        }
      ]
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

describe('on-disk layout', () => {
  it('keeps every chat of the state directory in its one database, and no per-chat file', async () => {
    const journal: AgentSessionJournal = await open()
    await journal.appendItem(item(0), body('a'), {
      fence: 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    expect(await readdir(root)).toContain('agent-session-journal.db')
    expect(await readdir(root)).not.toContain('agent-session-journal')
    await journal.close()
    await withJournalDatabase(root, (db) => {
      expect(liveTestJournalRows(db, IDENTITY.sessionId)[1]?.rowJson).toContain('"kind":"item"')
      expect(db.prepare('SELECT epoch FROM journal_sessions').get()).toMatchObject({
        epoch: journal.epoch
      })
    })
  })
})

/** Opens the session database directly, so a case can stage a fault or read
 *  back what a commit actually stored. */
async function withJournalDatabase(
  stateDirectory: string,
  run: (db: Database.Database) => void
): Promise<void> {
  const opened = openTestJournalHostDatabase(stateDirectory)
  try {
    run(opened.db)
  } finally {
    opened.close()
  }
}

describe('what a handle found on disk when it opened', () => {
  const submission = (clientMessageId: string) => ({
    clientMessageId,
    payloadFingerprint: 'fp',
    body: { kind: 'message' as const, role: 'user' as const, blocks: [] },
    fence: 1,
    handoverRecorded: true as const
  })

  it('names rows an earlier handle wrote, and never a row of a later epoch', async () => {
    const earlier = await open()
    await earlier.appendItem(item(1), body('one'), {
      fence: 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    await earlier.appendSubmission(submission('earlier'))
    await earlier.close()

    const journal = await open()
    const leftover = journal.submissions().find((entry) => entry.clientMessageId === 'earlier')
    expect(journal.wroteBeforeOpen(leftover?.acceptedSequence)).toBe(true)

    // Sequences restart with an epoch, so a row accepted after it can sit below the open cursor.
    await journal.replaceEpochItems('handle_forked', 1, [])
    await journal.appendSubmission(submission('later'))
    const later = journal.submissions().find((entry) => entry.clientMessageId === 'later')
    expect(later?.acceptedSequence).toBeLessThanOrEqual(2)
    expect(journal.wroteBeforeOpen(later?.acceptedSequence)).toBe(false)
  })
})
