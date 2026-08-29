import { appendFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  agentJournalSubmissionKey,
  boundJournalKeyComponent
} from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
import { AGENT_SESSION_HISTORY_MAX_LIMIT } from '../../../shared/agent-session-wire'
import {
  REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES,
  serializeRemoteRuntimePayload
} from '../../../shared/remote-runtime-memory-limits'
import { structuredAgentSessionPayloadFingerprint } from '../../../shared/structured-agent-session-mutation'
import { JOURNAL_LOG_FILE } from '../agent-session-journal/journal-log-file'
import {
  serializeJournalRow,
  type JournalItemRow,
  type JournalRow,
  type JournalTombstoneRow
} from '../agent-session-journal/journal-row-schema'
import {
  openAgentSessionJournal,
  type AgentSessionJournal
} from '../agent-session-journal/journal-store'
import { projectJournalBatch } from './agent-session-journal-batch'
import { readAgentSessionHistory, resolveHistoryLimit } from './agent-session-history-page'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}

let root: string
let clock = 1_000
let epochs = 0
let journal: AgentSessionJournal

function tick(): number {
  clock += 1
  return clock
}

function item(ordinal: number): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal }
}

function body(text: string): AgentJournalItemBody {
  return { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
}

async function appendItems(count: number): Promise<void> {
  for (let ordinal = 1; ordinal <= count; ordinal += 1) {
    await journal.appendItem(item(ordinal), body(`item-${ordinal}`), { fence: 1 })
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-wire-history-'))
  clock = 1_000
  epochs = 0
  journal = await openAgentSessionJournal({
    identity: IDENTITY,
    journalDir: root,
    now: tick,
    mintEpoch: () => {
      epochs += 1
      return `epoch-${epochs}`
    }
  })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('resolveHistoryLimit', () => {
  it('clamps rather than rejecting so a mid-scroll client keeps paging', () => {
    expect(resolveHistoryLimit(undefined)).toBe(40)
    expect(resolveHistoryLimit(0)).toBe(1)
    expect(resolveHistoryLimit(-5)).toBe(1)
    expect(resolveHistoryLimit(10_000)).toBe(AGENT_SESSION_HISTORY_MAX_LIMIT)
    expect(resolveHistoryLimit(Number.NaN)).toBe(40)
  })
})

describe('readAgentSessionHistory', () => {
  it('serves the newest page on tail and pages backward from it', async () => {
    await appendItems(5)
    const tail = readAgentSessionHistory(journal, {
      sessionId: 'session-1',
      direction: 'tail',
      limit: 2
    })
    if (!tail.ok) {
      throw new Error(`expected a page, got reset ${tail.reset}`)
    }
    expect(tail.page.items.map((entry) => entry.body)).toEqual([body('item-4'), body('item-5')])
    expect(tail.page.hasOlder).toBe(true)
    expect(tail.page.hasNewer).toBe(false)
    expect(tail.page.liveCursor).toEqual(journal.cursor())

    const older = readAgentSessionHistory(journal, {
      sessionId: 'session-1',
      direction: 'before',
      cursor: tail.page.window.nextCursor,
      limit: 2
    })
    if (!older.ok) {
      throw new Error(`expected a page, got reset ${older.reset}`)
    }
    expect(older.page.items.map((entry) => entry.body)).toEqual([body('item-2'), body('item-3')])
    expect(older.page.hasNewer).toBe(true)
  })

  it('catches a live reader up from its cursor and stops at the limit', async () => {
    await appendItems(2)
    const cursor = journal.cursor()
    await appendItems(5)
    const page = readAgentSessionHistory(journal, {
      sessionId: 'session-1',
      direction: 'after',
      cursor,
      limit: 2
    })
    if (!page.ok) {
      throw new Error(`expected a page, got reset ${page.reset}`)
    }
    expect(page.page.items).toHaveLength(2)
    expect(page.page.hasNewer).toBe(true)
    expect(page.page.window.nextCursor.sequence).toBeGreaterThan(cursor.sequence)
  })

  it('carries tombstones in a forward catch-up page', async () => {
    await appendItems(1)
    const cursor = journal.cursor()
    await journal.appendTombstone(item(1), { fence: 1 })

    const page = readAgentSessionHistory(journal, {
      sessionId: 'session-1',
      direction: 'after',
      cursor
    })
    if (!page.ok) {
      throw new Error(`expected a page, got reset ${page.reset}`)
    }
    expect(page.page.items).toHaveLength(0)
    expect(page.page.removedItemIds).toEqual(['codex:thread-1:turn-1:1'])
  })

  it('reports a forward read with no cursor as cursor_ahead rather than serving the tail', async () => {
    await appendItems(1)
    expect(
      readAgentSessionHistory(journal, { sessionId: 'session-1', direction: 'after' })
    ).toMatchObject({ ok: false, reset: 'cursor_ahead' })
  })

  it('resets a cursor from a previous epoch', async () => {
    await appendItems(1)
    const stale = journal.cursor()
    await journal.rollEpoch('legacy_import', 2)
    for (const direction of ['before', 'after'] as const) {
      expect(
        readAgentSessionHistory(journal, { sessionId: 'session-1', direction, cursor: stale })
      ).toMatchObject({ ok: false, reset: 'epoch_changed' })
    }
  })

  it('resets a cursor ahead of the journal', async () => {
    await appendItems(1)
    const ahead = { epoch: journal.epoch, sequence: journal.cursor().sequence + 10 }
    expect(
      readAgentSessionHistory(journal, {
        sessionId: 'session-1',
        direction: 'before',
        cursor: ahead
      })
    ).toMatchObject({ ok: false, reset: 'cursor_ahead' })
  })

  it('carries the submission for a message on the page', async () => {
    await journal.appendSubmission({
      clientMessageId: 'msg-1',
      payloadFingerprint: 'a'.repeat(64),
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] },
      fence: 1
    })
    const page = readAgentSessionHistory(journal, { sessionId: 'session-1', direction: 'tail' })
    if (!page.ok) {
      throw new Error(`expected a page, got reset ${page.reset}`)
    }
    expect(page.page.items[0]?.itemId).toBe(agentJournalSubmissionKey('msg-1'))
    expect(page.page.submissions).toHaveLength(1)
    expect(page.page.submissions[0]).toMatchObject({
      clientMessageId: 'msg-1',
      dispatchState: 'pending'
    })
  })
})

describe('history page byte ceiling', () => {
  // A legal user message may be 256 KiB; twenty of them serialize past the
  // 4 MiB outbound channel cap, which closes the socket on overflow.
  const LARGE_TEXT = 'x'.repeat(250 * 1024)

  async function appendLargeItems(count: number): Promise<void> {
    for (let ordinal = 1; ordinal <= count; ordinal += 1) {
      await journal.appendItem(item(ordinal), body(`${ordinal}:${LARGE_TEXT}`), { fence: 1 })
    }
  }

  function pageOf(result: ReturnType<typeof readAgentSessionHistory>) {
    if (!result.ok) {
      throw new Error(`expected a page, got reset ${result.reset}`)
    }
    // The actual channel gate: the page must serialize under the outbound cap.
    serializeRemoteRuntimePayload(result.page)
    return result.page
  }

  it('keeps a tail of legal large messages under the channel cap and still pages back to every item', async () => {
    await appendLargeItems(20)

    const tail = pageOf(
      readAgentSessionHistory(journal, { sessionId: 'session-1', direction: 'tail', limit: 40 })
    )
    expect(tail.items.length).toBeGreaterThan(0)
    expect(tail.hasOlder).toBe(true)

    const seen = tail.items.map((entry) => entry.itemId)
    let cursor = tail.window.nextCursor
    let hasOlder = tail.hasOlder
    let guard = 0
    while (hasOlder) {
      guard += 1
      expect(guard).toBeLessThan(30)
      const page = pageOf(
        readAgentSessionHistory(journal, {
          sessionId: 'session-1',
          direction: 'before',
          cursor,
          limit: 40
        })
      )
      expect(page.items.length).toBeGreaterThan(0)
      seen.push(...page.items.map((entry) => entry.itemId))
      cursor = page.window.nextCursor
      hasOlder = page.hasOlder
    }
    expect(new Set(seen).size).toBe(20)
  })

  it('bounds a forward catch-up page by bytes and keeps replaying to the head', async () => {
    const start = { epoch: journal.epoch, sequence: 0 }
    await appendLargeItems(20)

    const first = pageOf(
      readAgentSessionHistory(journal, {
        sessionId: 'session-1',
        direction: 'after',
        cursor: start,
        limit: 40
      })
    )
    expect(first.items.length).toBeGreaterThan(0)
    expect(first.hasNewer).toBe(true)

    const seen = first.items.map((entry) => entry.itemId)
    let cursor = first.window.nextCursor
    let hasNewer = first.hasNewer
    let guard = 0
    while (hasNewer) {
      guard += 1
      expect(guard).toBeLessThan(30)
      const page = pageOf(
        readAgentSessionHistory(journal, {
          sessionId: 'session-1',
          direction: 'after',
          cursor,
          limit: 40
        })
      )
      expect(page.items.length).toBeGreaterThan(0)
      seen.push(...page.items.map((entry) => entry.itemId))
      cursor = page.window.nextCursor
      hasNewer = page.hasNewer
    }
    expect(new Set(seen).size).toBe(20)
  })

  it('degrades a single over-budget item to a visible truncation marker instead of overflowing', async () => {
    await journal.appendItem(item(1), body(`1:${'y'.repeat(3 * 1024 * 1024)}`), { fence: 1 })

    const tail = pageOf(
      readAgentSessionHistory(journal, { sessionId: 'session-1', direction: 'tail', limit: 40 })
    )
    expect(tail.items).toHaveLength(1)
    const bodyOnPage = tail.items[0]?.body
    expect(bodyOnPage?.kind).toBe('status')
    expect(bodyOnPage?.kind === 'status' ? bodyOnPage.text : '').toContain('[Orca: item truncated')
  })
})

describe('projectJournalBatch', () => {
  it('reports a hole in the row sequence as journal_gap', async () => {
    await appendItems(3)
    const since = journal.readSince({ epoch: journal.epoch, sequence: 0 })
    if (!since.ok) {
      throw new Error(`expected rows, got reset ${since.reset}`)
    }
    const withHole = since.rows.filter((row) => row.seq !== since.rows[1]?.seq)
    expect(
      projectJournalBatch({ rows: withHole, snapshot: journal.snapshot(), afterSequence: 0 })
    ).toEqual({ ok: false, reset: 'journal_gap' })
  })

  it('publishes touched items at their current reduced state, not as a delta', async () => {
    await appendItems(1)
    const cursor = journal.cursor()
    await journal.appendItem(item(1), body('revised'), { fence: 1 })
    const since = journal.readSince(cursor)
    if (!since.ok) {
      throw new Error(`expected rows, got reset ${since.reset}`)
    }
    const projected = projectJournalBatch({
      rows: since.rows,
      snapshot: journal.snapshot(),
      afterSequence: cursor.sequence
    })
    if (!projected.ok) {
      throw new Error(`expected a batch, got reset ${projected.reset}`)
    }
    expect(projected.batch.items).toHaveLength(1)
    expect(projected.batch.items[0]).toMatchObject({ body: body('revised'), revision: 2 })
    expect(projected.batch.cursor).toEqual(journal.cursor())
  })

  it('lists a tombstoned item as removed', async () => {
    await appendItems(1)
    const cursor = journal.cursor()
    await journal.appendTombstone(item(1), { fence: 1 })
    const since = journal.readSince(cursor)
    if (!since.ok) {
      throw new Error(`expected rows, got reset ${since.reset}`)
    }
    const projected = projectJournalBatch({
      rows: since.rows,
      snapshot: journal.snapshot(),
      afterSequence: cursor.sequence
    })
    if (!projected.ok) {
      throw new Error(`expected a batch, got reset ${projected.reset}`)
    }
    expect(projected.batch.removedItemIds).toHaveLength(1)
    expect(projected.batch.items).toHaveLength(0)
  })

  it('publishes a mismatched provider echo under its submission slot', async () => {
    const message: AgentJournalMessageItem = {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'queued follow-up' }]
    }
    await journal.appendSubmission({
      clientMessageId: 'client-follow-up',
      payloadFingerprint: structuredAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: IDENTITY.sessionId,
        fields: { body: message }
      }),
      body: message,
      fence: 1
    })
    const cursor = journal.cursor()
    await journal.resolveDispatch({
      clientMessageId: 'client-follow-up',
      state: 'accepted',
      providerIdentity: {
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'predicted',
        ordinal: 0
      },
      fence: 1
    })
    await journal.appendItem(
      { provider: 'codex', threadId: 'thread-1', turnId: 'root-turn', ordinal: 2 },
      message,
      { fence: 1 }
    )

    const page = readAgentSessionHistory(journal, {
      sessionId: IDENTITY.sessionId,
      direction: 'after',
      cursor
    })
    if (!page.ok) {
      throw new Error(`expected a page, got reset ${page.reset}`)
    }
    expect(page.page.items).toMatchObject([
      { itemId: agentJournalSubmissionKey('client-follow-up'), revision: 1 }
    ])
    expect(page.page.removedItemIds).toEqual([])
  })
})

/** Serialize through the actual channel gate and hand back the byte length. */
function serializedPageBytes(value: unknown): number {
  return Buffer.byteLength(serializeRemoteRuntimePayload(value), 'utf8')
}

type RawSeedRow =
  | Omit<JournalItemRow, 'v' | 'epoch' | 'fence' | 'ts'>
  | Omit<JournalTombstoneRow, 'v' | 'epoch' | 'fence' | 'ts'>

/** Simulate rows admitted before identity bounding existed: written straight
 *  into the log, then loaded by a fresh journal instance. */
async function reopenWithRawRows(rows: readonly RawSeedRow[]): Promise<AgentSessionJournal> {
  const full = rows.map(
    (row) =>
      ({
        ...row,
        v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
        epoch: journal.epoch,
        fence: 1,
        ts: tick()
      }) as JournalRow
  )
  await appendFile(
    join(root, JOURNAL_LOG_FILE),
    `${full.map(serializeJournalRow).join('\n')}\n`,
    'utf-8'
  )
  return openAgentSessionJournal({ identity: IDENTITY, journalDir: root, now: tick })
}

describe('pre-existing oversized identities', () => {
  // The exact escape from the round-two review: a legal 5 MiB Codex turnId
  // admitted before bounding, then tombstoned. Its removal id alone exceeds
  // the 4 MiB outbound cap, so no page can ever carry it.
  const HUGE_ITEM_ID = `codex:thread-1:${'h'.repeat(5 * 1024 * 1024)}:1`

  it('answers an unfittable pre-existing removal with a bounded reset instead of an unsendable page', async () => {
    const seq = journal.cursor().sequence
    const reopened = await reopenWithRawRows([
      { kind: 'item', itemId: HUGE_ITEM_ID, revision: 1, seq: seq + 1, body: body('big') },
      { kind: 'tombstone', itemId: HUGE_ITEM_ID, revision: 2, seq: seq + 2 }
    ])

    for (const sequence of [seq, seq + 1]) {
      const result = readAgentSessionHistory(reopened, {
        sessionId: 'session-1',
        direction: 'after',
        cursor: { epoch: reopened.epoch, sequence },
        limit: 40
      })
      expect(result.ok).toBe(false)
      if (result.ok) {
        throw new Error('expected a reset')
      }
      expect(result.reset).toBe('cursor_compacted')
      expect(serializedPageBytes(result.page)).toBeLessThanOrEqual(
        REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES
      )
      // The reset page replaces client state wholesale, so the removal is
      // applied without carrying the id, and resuming from the live cursor
      // starts past the unsendable row.
      expect(result.page.items).toEqual([])
      const liveCursor = result.page.liveCursor
      if (!liveCursor) {
        throw new Error('expected a live cursor on the reset page')
      }
      expect(liveCursor.sequence).toBeGreaterThanOrEqual(seq + 2)

      const resumed = readAgentSessionHistory(reopened, {
        sessionId: 'session-1',
        direction: 'after',
        cursor: liveCursor,
        limit: 40
      })
      expect(resumed.ok).toBe(true)
    }
  })

  it('charges removal ids into the page budget and splits catch-up instead of overflowing', async () => {
    const seq = journal.cursor().sequence
    const removalIds = Array.from(
      { length: 30 },
      (_, index) => `codex:thread-1:${'r'.repeat(250 * 1024)}:${index}`
    )
    const reopened = await reopenWithRawRows(
      removalIds.map((itemId, index) => ({
        kind: 'tombstone' as const,
        itemId,
        revision: 1,
        seq: seq + 1 + index
      }))
    )

    const seen = new Set<string>()
    let cursor = { epoch: reopened.epoch, sequence: seq }
    let guard = 0
    while (true) {
      guard += 1
      expect(guard).toBeLessThan(30)
      const result = readAgentSessionHistory(reopened, {
        sessionId: 'session-1',
        direction: 'after',
        cursor,
        limit: 40
      })
      if (!result.ok) {
        throw new Error(`expected a page, got reset ${result.reset}`)
      }
      expect(serializedPageBytes(result.page)).toBeLessThanOrEqual(
        REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES
      )
      for (const removed of result.page.removedItemIds) {
        seen.add(removed)
      }
      cursor = result.page.window.nextCursor
      if (!result.page.hasNewer) {
        break
      }
    }
    expect(seen).toEqual(new Set(removalIds))
  })

  it('bounds the truncation marker id for a live oversized-id item', async () => {
    const seq = journal.cursor().sequence
    const reopened = await reopenWithRawRows([
      { kind: 'item', itemId: HUGE_ITEM_ID, revision: 1, seq: seq + 1, body: body('big') }
    ])

    const tail = readAgentSessionHistory(reopened, {
      sessionId: 'session-1',
      direction: 'tail',
      limit: 40
    })
    if (!tail.ok) {
      throw new Error(`expected a page, got reset ${tail.reset}`)
    }
    expect(serializedPageBytes(tail.page)).toBeLessThanOrEqual(
      REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES
    )
    expect(tail.page.items).toHaveLength(1)
    const marker = tail.page.items[0]
    expect(marker?.body.kind).toBe('status')
    expect(marker?.itemId).toBe(boundJournalKeyComponent(HUGE_ITEM_ID))
    expect(marker?.itemId.length).toBeLessThan(2048)

    const forward = readAgentSessionHistory(reopened, {
      sessionId: 'session-1',
      direction: 'after',
      cursor: { epoch: reopened.epoch, sequence: seq },
      limit: 40
    })
    if (!forward.ok) {
      throw new Error(`expected a page, got reset ${forward.reset}`)
    }
    expect(serializedPageBytes(forward.page)).toBeLessThanOrEqual(
      REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES
    )
    expect(forward.page.items[0]?.itemId).toBe(boundJournalKeyComponent(HUGE_ITEM_ID))
  })
})

describe('identity bounding at admission', () => {
  it('bounds a new oversized provider identity so its item and removal share one sendable key', async () => {
    const oversized: AgentJournalItemIdentity = {
      provider: 'codex',
      threadId: 'thread-1',
      turnId: 'T'.repeat(5 * 1024 * 1024),
      ordinal: 1
    }
    const start = { epoch: journal.epoch, sequence: journal.cursor().sequence }
    const appended = await journal.appendItem(oversized, body('bounded'), { fence: 1 })
    expect(appended.itemId.length).toBeLessThan(2048)
    expect(appended.itemId).toContain('~orca-oversized~')

    const beforeTombstone = journal.cursor()
    await journal.appendTombstone(oversized, { fence: 1 })

    const created = readAgentSessionHistory(journal, {
      sessionId: 'session-1',
      direction: 'after',
      cursor: start,
      limit: 40
    })
    if (!created.ok) {
      throw new Error(`expected a page, got reset ${created.reset}`)
    }
    expect(serializedPageBytes(created.page)).toBeLessThanOrEqual(
      REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES
    )
    expect(created.page.removedItemIds).toEqual([appended.itemId])

    const removal = readAgentSessionHistory(journal, {
      sessionId: 'session-1',
      direction: 'after',
      cursor: beforeTombstone,
      limit: 40
    })
    if (!removal.ok) {
      throw new Error(`expected a page, got reset ${removal.reset}`)
    }
    expect(serializedPageBytes(removal.page)).toBeLessThanOrEqual(
      REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES
    )
    expect(removal.page.removedItemIds).toEqual([appended.itemId])
  })

  it('keeps bounded keys deterministic and a fixed point of re-derivation', () => {
    const oversized = 'x'.repeat(2 * 1024 * 1024)
    const bounded = boundJournalKeyComponent(oversized)
    expect(bounded).toBe(boundJournalKeyComponent(oversized))
    expect(boundJournalKeyComponent(bounded)).toBe(bounded)
    expect(bounded.length).toBeLessThan(2048)
    expect(boundJournalKeyComponent(`${oversized}y`)).not.toBe(bounded)
    expect(boundJournalKeyComponent('short')).toBe('short')
  })
})
