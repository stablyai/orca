import type { AgentJournalItemIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { readAgentSessionConversationOutline } from './agent-session-conversation-outline'
import { shortenedAgentJournalItem } from './agent-session-item-wire-form'
import { firstStructuredChatNamingPrompt } from '../../../shared/structured-chat-naming-eligibility'
import { structuredSessionGateFacts } from '../../runtime/orchestration/structured-session-pointer-delivery'
import { describe, expect, it } from 'vitest'
import {
  readTestJournalRows,
  updateTestJournalRowJson
} from '../agent-session-journal/journal-native-fixture-test-support'
import { hostTestMessage } from './structured-agent-session-host-test-data'
import {
  agentJournalSubmissionKey,
  agentJournalItemKey
} from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalMessageItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'

import { serializeRemoteRuntimePayload } from '../../../shared/remote-runtime/remote-runtime-memory-limits'
import { structuredAgentSessionPayloadFingerprint } from '../../../shared/agent-session/lifecycle/structured-agent-session-mutation'
import { projectJournalBatch } from './agent-session-journal-batch'
import {
  readAgentSessionHistory,
  createAgentSessionCatchUpReader
} from './agent-session-history-page'
import {
  fixture,
  journals,
  IDENTITY,
  appendItems,
  body,
  item
} from './agent-session-history-contract-test-fixture'

describe('readAgentSessionHistory', () => {
  it('refreshes a retained catch-up reader after a same-cursor disk reload', async () => {
    const options = { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    await fixture.journal.appendItem(
      item(0),
      { kind: 'turn', turnId: 'turn-1', state: 'running' },
      options
    )
    const view = fixture.journal.publicRead()
    expect(view.snapshot.items).toHaveLength(1)
    const cursor = fixture.journal.cursor()
    const read = createAgentSessionCatchUpReader(fixture.journal, undefined, view)
    const request = {
      sessionId: IDENTITY.sessionId,
      direction: 'after' as const,
      cursor: { epoch: cursor.epoch, sequence: 0 }
    }
    expect(await read(request)).toMatchObject({
      ok: true,
      page: { items: [{ body: { state: 'running' } }], latestTurn: { turn: { state: 'running' } } }
    })
    const database = await openTestJournalHostDatabase(fixture.root)
    const rows = await readTestJournalRows(database, IDENTITY.sessionId, cursor.epoch)
    const saved = rows.find((row) => row.seq === cursor.sequence)
    if (!saved) {
      throw new Error('missing saved turn')
    }
    const row = JSON.parse(saved.rowJson)
    row.body.state = 'completed'
    await updateTestJournalRowJson(
      database,
      IDENTITY.sessionId,
      cursor.sequence,
      JSON.stringify(row)
    )
    await fixture.journal.open()
    expect(fixture.journal.cursor()).toEqual(cursor)
    expect(await read(request)).toMatchObject({
      ok: true,
      page: {
        items: [{ body: { state: 'completed' } }],
        latestTurn: { turn: { state: 'completed' } }
      }
    })
  })

  it('serves current detail, outline, naming and mail facts without changing later history', async () => {
    const options = { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    await fixture.journal.appendSubmission({
      clientMessageId: 'u',
      payloadFingerprint: 'u',
      body: hostTestMessage('Name this'),
      fence: 1
    })
    const turn = await fixture.journal.appendItem(
      item(0),
      { kind: 'turn', turnId: 'turn-1', state: 'running' },
      options
    )
    const replies = { ...options, turnScope: { kind: 'turn' as const, turnItemId: turn.itemId } }
    await fixture.journal.appendItem(item(1), body('obsolete reply'), replies)
    await fixture.journal.appendItem(item(2), body('initial reply'), replies)
    const warm = fixture.journal.snapshot()
    await fixture.journal.resolveDispatch({
      clientMessageId: 'u',
      state: 'accepted',
      providerIdentity: null,
      fence: 1
    })
    await fixture.journal.appendItem(item(2), body('Revised reply'), replies)
    await fixture.journal.appendTombstone(item(1), { fence: 1 })
    await fixture.journal.appendItem(
      item(0),
      { kind: 'turn', turnId: 'turn-1', state: 'completed' },
      options
    )
    const current = fixture.journal.snapshot()
    const expected = structuredClone(current)
    expect(current).not.toBe(warm)
    const detail = current.items.at(-1)!
    expect(shortenedAgentJournalItem(detail, 1024)?.body).toMatchObject({
      blocks: [{ text: 'Revised reply' }]
    })
    expect(readAgentSessionConversationOutline(current).entries).toMatchObject([
      { preview: 'Name this', reply: 'Revised reply' }
    ])
    expect(firstStructuredChatNamingPrompt(current, 0)).toBe('Name this')
    expect(structuredSessionGateFacts(current.items).turnRunning).toBe(false)
    expect(current.submissions).toMatchObject([{ clientMessageId: 'u', dispatchState: 'accepted' }])
    expect(
      await readAgentSessionHistory(fixture.journal, {
        sessionId: IDENTITY.sessionId,
        direction: 'tail'
      })
    ).toMatchObject({
      ok: true,
      page: { items: expected.items, submissions: expected.submissions }
    })
    expect(fixture.journal.snapshot()).toEqual(expected)
  })

  it('serves the newest page on tail and pages backward from it', async () => {
    await appendItems(5)
    const tail = await readAgentSessionHistory(fixture.journal, {
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
    expect(tail.page.liveCursor).toEqual(fixture.journal.cursor())

    const older = await readAgentSessionHistory(fixture.journal, {
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

  it('resets old contexts and resumes the projected cursor after an atomic retained-log replacement', async () => {
    await appendItems(4)
    const before = fixture.journal.cursor()
    const kept = fixture.journal
      .snapshot()
      .items.slice(0, 2)
      .map((entry, index) => ({
        identity: item(index + 1),
        body: entry.body,
        observedAt: entry.observedAt,
        turnScope: entry.turnScope,
        ownerFence: fixture.journal.itemFence(entry.itemId) ?? 0
      }))
    let receipt = before
    await fixture.journal.replaceEpochItems('handle_forked', 1, kept, (cursor) => ({
      write: () => {
        receipt = cursor
      },
      committed: () => {}
    }))
    expect(receipt).toEqual(fixture.journal.cursor())
    for (const direction of ['before', 'after'] as const) {
      expect(
        await readAgentSessionHistory(fixture.journal, {
          sessionId: IDENTITY.sessionId,
          direction,
          cursor: before
        })
      ).toMatchObject({
        ok: false,
        reset: 'epoch_changed',
        page: {
          epoch: receipt.epoch,
          items: kept.map((entry) => expect.objectContaining({ body: entry.body }))
        }
      })
    }
    const physical = fixture.journal.physicalCursor()
    expect(physical.epoch).toBe(before.epoch)
    expect(physical.sequence).toBeGreaterThan(before.sequence)
    let appendedReceipt = before
    const appended = await fixture.journal.appendItem(
      item(5),
      body('after boundary'),
      { fence: 1, turnScope: { kind: 'thread' } },
      {
        write: (_db, row) => {
          appendedReceipt = { epoch: row!.epoch, sequence: row!.seq }
        },
        committed: () => {}
      }
    )
    expect(appended.cursor).toEqual(fixture.journal.cursor())
    expect(appendedReceipt).toEqual(appended.cursor)
    expect(
      await readAgentSessionHistory(fixture.journal, {
        sessionId: IDENTITY.sessionId,
        direction: 'after',
        cursor: receipt
      })
    ).toMatchObject({
      ok: true,
      page: {
        epoch: receipt.epoch,
        liveCursor: appended.cursor,
        items: [expect.objectContaining({ body: body('after boundary') })]
      }
    })
    await fixture.journal.close()
    fixture.journal = await journals.open({ identity: IDENTITY, stateDirectory: fixture.root })
    expect(fixture.journal.cursor()).toEqual(appended.cursor)
    const tail = await readAgentSessionHistory(fixture.journal, {
      sessionId: IDENTITY.sessionId,
      direction: 'tail',
      limit: 2
    })
    expect(tail).toMatchObject({ ok: true, page: { epoch: receipt.epoch, hasOlder: true } })
    if (!tail.ok) {
      throw new Error('missing tail')
    }
    expect(
      await readAgentSessionHistory(fixture.journal, {
        sessionId: IDENTITY.sessionId,
        direction: 'before',
        cursor: tail.page.window.nextCursor,
        limit: 2
      })
    ).toMatchObject({
      ok: true,
      page: { items: [expect.objectContaining({ body: body('item-1') })] }
    })
  })

  it('catches a live reader up from its cursor and stops at the limit', async () => {
    await appendItems(2)
    const cursor = fixture.journal.cursor()
    await appendItems(5)
    const page = await readAgentSessionHistory(fixture.journal, {
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
    const cursor = fixture.journal.cursor()
    await fixture.journal.appendTombstone(item(1), { fence: 1 })

    const page = await readAgentSessionHistory(fixture.journal, {
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
      await readAgentSessionHistory(fixture.journal, { sessionId: 'session-1', direction: 'after' })
    ).toMatchObject({ ok: false, reset: 'cursor_ahead' })
  })

  it('resets a cursor from a previous epoch', async () => {
    await appendItems(1)
    const stale = fixture.journal.cursor()
    await fixture.journal.rollEpoch('legacy_import', 2)
    for (const direction of ['before', 'after'] as const) {
      expect(
        await readAgentSessionHistory(fixture.journal, {
          sessionId: 'session-1',
          direction,
          cursor: stale
        })
      ).toMatchObject({ ok: false, reset: 'epoch_changed' })
    }
  })

  it('resets a cursor ahead of the journal', async () => {
    await appendItems(1)
    const ahead = { epoch: fixture.journal.epoch, sequence: fixture.journal.cursor().sequence + 10 }
    expect(
      await readAgentSessionHistory(fixture.journal, {
        sessionId: 'session-1',
        direction: 'before',
        cursor: ahead
      })
    ).toMatchObject({ ok: false, reset: 'cursor_ahead' })
  })

  it('carries the submission for a message on the page', async () => {
    await fixture.journal.appendSubmission({
      clientMessageId: 'msg-1',
      payloadFingerprint: 'a'.repeat(64),
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] },
      fence: 1
    })
    const page = await readAgentSessionHistory(fixture.journal, {
      sessionId: 'session-1',
      direction: 'tail'
    })
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
  // Several legal messages exceed the 4 MiB outbound cap.
  const LARGE_TEXT = 'x'.repeat(250 * 1024)

  async function appendLargeItems(count: number): Promise<void> {
    for (let ordinal = 1; ordinal <= count; ordinal += 1) {
      await fixture.journal.appendItem(item(ordinal), body(`${ordinal}:${LARGE_TEXT}`), {
        fence: 1,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
    }
  }

  function pageOf(result: Awaited<ReturnType<typeof readAgentSessionHistory>>) {
    if (!result.ok) {
      throw new Error(`expected a page, got reset ${result.reset}`)
    }
    serializeRemoteRuntimePayload(result.page)
    return result.page
  }

  it('keeps a tail of legal large messages under the channel cap and still pages back to every item', async () => {
    await appendLargeItems(20)

    const tail = pageOf(
      await readAgentSessionHistory(fixture.journal, {
        sessionId: 'session-1',
        direction: 'tail',
        limit: 40
      })
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
        await readAgentSessionHistory(fixture.journal, {
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
    const start = { epoch: fixture.journal.epoch, sequence: 0 }
    await appendLargeItems(20)

    const first = pageOf(
      await readAgentSessionHistory(fixture.journal, {
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
        await readAgentSessionHistory(fixture.journal, {
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

  it('sends a single over-budget item shortened and marked, never replaced', async () => {
    await fixture.journal.appendItem(item(1), body(`1:${'y'.repeat(3 * 1024 * 1024)}`), {
      fence: 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })

    const tail = pageOf(
      await readAgentSessionHistory(fixture.journal, {
        sessionId: 'session-1',
        direction: 'tail',
        limit: 40
      })
    )
    expect(tail.items).toHaveLength(1)
    const sent = tail.items[0]
    const text =
      sent?.body.kind === 'message' && sent.body.blocks[0]?.type === 'text'
        ? sent.body.blocks[0].text
        : ''
    expect(sent?.shortened).toBe(true)
    expect(text.startsWith('1:yyy')).toBe(true)
    expect(text.length).toBeLessThan(3 * 1024 * 1024)
  })
})

describe('projectJournalBatch', () => {
  it('publishes every nested lifecycle mutation atomically at the outer cursor', async () => {
    const turn: AgentJournalItemIdentity = {
      provider: 'legacy',
      agent: 'codex',
      sessionId: 'session-1',
      recordId: 'turn-lifecycle:turn-1'
    }
    await fixture.journal.appendItem(
      turn,
      { kind: 'status', text: 'working' },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    const cursor = fixture.journal.cursor()
    await fixture.journal.appendLifecycleBatch({
      settlementId: 'settlement-1',
      fence: 1,
      mutations: [
        {
          kind: 'item',
          identity: item(1),
          body: body('one'),
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        },
        {
          kind: 'item',
          identity: item(2),
          body: body('two'),
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        },
        { kind: 'tombstone', identity: turn }
      ]
    })

    const page = await readAgentSessionHistory(fixture.journal, {
      sessionId: 'session-1',
      direction: 'after',
      cursor,
      limit: 1
    })
    if (!page.ok) {
      throw new Error(`expected a page, got reset ${page.reset}`)
    }
    expect(page.page.items.map((entry) => entry.body)).toEqual([body('one'), body('two')])
    expect(page.page.removedItemIds).toHaveLength(1)
    expect(new Set(page.page.items.map((entry) => entry.sequence)).size).toBe(1)

    const tail = await readAgentSessionHistory(fixture.journal, {
      sessionId: 'session-1',
      direction: 'tail',
      limit: 1
    })
    if (!tail.ok) {
      throw new Error(`expected a page, got reset ${tail.reset}`)
    }
    expect(tail.page.items.map((entry) => entry.body)).toEqual([body('one'), body('two')])
  })

  it('reports a hole in the row sequence as journal_gap', async () => {
    await appendItems(3)
    const since = await fixture.journal.readSince({ epoch: fixture.journal.epoch, sequence: 0 })
    if (!since.ok) {
      throw new Error(`expected rows, got reset ${since.reset}`)
    }
    const withHole = since.rows.filter((row) => row.seq !== since.rows[1]?.seq)
    expect(
      projectJournalBatch({
        rows: withHole,
        snapshot: fixture.journal.snapshot(),
        afterSequence: 0
      })
    ).toEqual({ ok: false, reset: 'journal_gap' })
  })

  it('publishes touched items at their current reduced state, not as a delta', async () => {
    await appendItems(1)
    const cursor = fixture.journal.cursor()
    await fixture.journal.appendItem(item(1), body('revised'), {
      fence: 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    const since = await fixture.journal.readSince(cursor)
    if (!since.ok) {
      throw new Error(`expected rows, got reset ${since.reset}`)
    }
    const projected = projectJournalBatch({
      rows: since.rows,
      snapshot: fixture.journal.snapshot(),
      afterSequence: cursor.sequence
    })
    if (!projected.ok) {
      throw new Error(`expected a batch, got reset ${projected.reset}`)
    }
    expect(projected.batch.items).toHaveLength(1)
    expect(projected.batch.items[0]).toMatchObject({ body: body('revised'), revision: 2 })
    expect(projected.batch.cursor).toEqual(fixture.journal.cursor())
  })

  it('lists a tombstoned item as removed', async () => {
    await appendItems(1)
    const cursor = fixture.journal.cursor()
    await fixture.journal.appendTombstone(item(1), { fence: 1 })
    const since = await fixture.journal.readSince(cursor)
    if (!since.ok) {
      throw new Error(`expected rows, got reset ${since.reset}`)
    }
    const projected = projectJournalBatch({
      rows: since.rows,
      snapshot: fixture.journal.snapshot(),
      afterSequence: cursor.sequence
    })
    if (!projected.ok) {
      throw new Error(`expected a batch, got reset ${projected.reset}`)
    }
    expect(projected.batch.removedItemIds).toHaveLength(1)
    expect(projected.batch.items).toHaveLength(0)
  })

  it('publishes a mismatched provider echo under its kept submission slot after replacement', async () => {
    const message: AgentJournalMessageItem = {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'queued follow-up' }]
    }
    await fixture.journal.appendSubmission({
      clientMessageId: 'client-follow-up',
      payloadFingerprint: structuredAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: IDENTITY.sessionId,
        fields: { body: message }
      }),
      body: message,
      fence: 1
    })
    await fixture.journal.replaceEpochItems('handle_forked', 1, [
      {
        identity: { provider: 'orca', clientMessageId: 'client-follow-up' },
        body: message,
        ownerFence: 1,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      }
    ])
    const cursor = fixture.journal.cursor()
    await fixture.journal.resolveDispatch({
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
    await fixture.journal.appendItem(
      { provider: 'codex', threadId: 'thread-1', turnId: 'root-turn', ordinal: 2 },
      message,
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )

    const page = await readAgentSessionHistory(fixture.journal, {
      sessionId: IDENTITY.sessionId,
      direction: 'after',
      cursor
    })
    if (!page.ok) {
      throw new Error(`expected a page, got reset ${page.reset}`)
    }
    expect(page.page.items).toMatchObject([
      { itemId: agentJournalSubmissionKey('client-follow-up'), revision: 2 }
    ])
    expect(
      fixture.journal.canonicalItemId(
        agentJournalItemKey({
          provider: 'codex',
          threadId: 'thread-1',
          turnId: 'root-turn',
          ordinal: 2
        })
      )
    ).toBe(agentJournalSubmissionKey('client-follow-up'))
    expect(page.page.removedItemIds).toEqual([])
  })
})
