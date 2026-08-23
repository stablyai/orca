import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { AGENT_SESSION_HISTORY_MAX_LIMIT } from '../../../shared/agent-session-wire'
import { serializeRemoteRuntimePayload } from '../../../shared/remote-runtime-memory-limits'
import { structuredAgentSessionPayloadFingerprint } from '../../../shared/structured-agent-session-mutation'
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
