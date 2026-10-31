import { describe, expect, it } from 'vitest'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { AGENT_SESSION_HISTORY_MAX_LIMIT } from '../../../shared/agent-session-wire'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { hostTestMessage } from './structured-agent-session-host-test-data'
import {
  createAgentSessionCatchUpReader,
  readAgentSessionHistory,
  resolveHistoryLimit
} from './agent-session-history-page'
import { readAgentSessionConversationOutline } from './agent-session-conversation-outline'
import { shortenedAgentJournalItem } from './agent-session-item-wire-form'
import { firstStructuredChatNamingPrompt } from '../../../shared/structured-chat-naming-eligibility'
import { structuredSessionGateFacts } from '../../runtime/orchestration/structured-session-pointer-delivery'

import {
  fixture,
  IDENTITY,
  appendItems,
  body,
  item
} from './agent-session-history-contract-test-fixture'

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
    expect(read(request)).toMatchObject({
      ok: true,
      page: { items: [{ body: { state: 'running' } }], latestTurn: { turn: { state: 'running' } } }
    })
    const { db } = openTestJournalHostDatabase(fixture.root)
    db.prepare(
      "UPDATE journal_rows SET row_json = json_set(row_json, '$.body.state', 'completed') WHERE session_id = ? AND epoch = ? AND seq = ?"
    ).run(IDENTITY.sessionId, cursor.epoch, cursor.sequence)
    await fixture.journal.open()
    expect(fixture.journal.cursor()).toEqual(cursor)
    expect(read(request)).toMatchObject({
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
      readAgentSessionHistory(fixture.journal, { sessionId: IDENTITY.sessionId, direction: 'tail' })
    ).toMatchObject({
      ok: true,
      page: { items: expected.items, submissions: expected.submissions }
    })
    expect(fixture.journal.snapshot()).toEqual(expected)
  })

  it('serves the newest page on tail and pages backward from it', async () => {
    await appendItems(5)
    const tail = readAgentSessionHistory(fixture.journal, {
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

    const older = readAgentSessionHistory(fixture.journal, {
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
    const cursor = fixture.journal.cursor()
    await appendItems(5)
    const page = readAgentSessionHistory(fixture.journal, {
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

    const page = readAgentSessionHistory(fixture.journal, {
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
      readAgentSessionHistory(fixture.journal, { sessionId: 'session-1', direction: 'after' })
    ).toMatchObject({ ok: false, reset: 'cursor_ahead' })
  })

  it('resets a cursor from a previous epoch', async () => {
    await appendItems(1)
    const stale = fixture.journal.cursor()
    await fixture.journal.rollEpoch('legacy_import', 2)
    for (const direction of ['before', 'after'] as const) {
      expect(
        readAgentSessionHistory(fixture.journal, {
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
      readAgentSessionHistory(fixture.journal, {
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
    const page = readAgentSessionHistory(fixture.journal, {
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
