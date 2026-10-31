import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemIdentity,
  AgentJournalMessageItem
} from '../../../shared/agent-session-journal-types'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { structuredAgentSessionPayloadFingerprint } from '../../../shared/structured-agent-session-mutation'
import {
  closeTestJournalHostDatabase,
  createTrackedJournalOpener
} from '../agent-session-journal/journal-host-database-test-support'
import { projectJournalBatch } from './agent-session-journal-batch'
import { readAgentSessionHistory } from './agent-session-history-page'

import {
  fixture,
  IDENTITY,
  appendItems,
  body,
  item,
  tick
} from './agent-session-history-contract-test-fixture'

const outcomeJournals = createTrackedJournalOpener()

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

    const page = readAgentSessionHistory(fixture.journal, {
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

    const tail = readAgentSessionHistory(fixture.journal, {
      sessionId: 'session-1',
      direction: 'tail',
      limit: 1
    })
    if (!tail.ok) {
      throw new Error(`expected a page, got reset ${tail.reset}`)
    }
    expect(tail.page.items.map((entry) => entry.body)).toEqual([body('one'), body('two')])
  })

  it('accepts sparse outcome sequence groups', async () => {
    // The shared fixture pins the input format; sparse groups exist only in an outcome epoch.
    const root = await mkdtemp(join(tmpdir(), 'orca-history-outcomes-'))
    const journal = await outcomeJournals.open({
      identity: IDENTITY,
      stateDirectory: root,
      now: tick
    })
    try {
      for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
        await journal.appendItem(item(ordinal), body(`item-${ordinal}`), {
          fence: 1,
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        })
      }
      const since = journal.readSince({ epoch: journal.epoch, sequence: 0 })
      if (!since.ok) {
        throw new Error(`expected rows, got reset ${since.reset}`)
      }
      expect(since.rows.every((row) => row.kind === 'outcome')).toBe(true)
      const withHole = since.rows.filter((row) => row.seq !== since.rows[1]?.seq)
      expect(
        projectJournalBatch({ rows: withHole, snapshot: journal.snapshot(), afterSequence: 0 })
      ).toMatchObject({ ok: true })
    } finally {
      await journal.close()
      await closeTestJournalHostDatabase(root)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('publishes touched items at their current reduced state, not as a delta', async () => {
    await appendItems(1)
    const cursor = fixture.journal.cursor()
    await fixture.journal.appendItem(item(1), body('revised'), {
      fence: 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    const since = fixture.journal.readSince(cursor)
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
    const since = fixture.journal.readSince(cursor)
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

  it('publishes a mismatched provider echo under its submission slot', async () => {
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

    const page = readAgentSessionHistory(fixture.journal, {
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
