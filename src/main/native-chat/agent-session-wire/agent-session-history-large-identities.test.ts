import { describe, expect, it } from 'vitest'
import { boundJournalKeyComponent } from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalItemIdentity } from '../../../shared/agent-session-journal-types'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES } from '../../../shared/remote-runtime/remote-runtime-memory-limits'
import { readAgentSessionHistory } from './agent-session-history-page'

import {
  fixture,
  body,
  reopenWithRawRows,
  serializedPageBytes
} from './agent-session-history-contract-test-fixture'

describe('pre-existing oversized identities', () => {
  // Legacy oversized tombstone IDs cannot fit any outbound page.
  const HUGE_ITEM_ID = `codex:thread-1:${'h'.repeat(5 * 1024 * 1024)}:1`

  it('answers an unfittable pre-existing removal with a bounded reset instead of an unsendable page', async () => {
    const seq = fixture.journal.cursor().sequence
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
      // Reset replaces client state without sending an unsendable removal ID.
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
    const seq = fixture.journal.cursor().sequence
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
    const seq = fixture.journal.cursor().sequence
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
    const start = { epoch: fixture.journal.epoch, sequence: fixture.journal.cursor().sequence }
    const appended = await fixture.journal.appendItem(oversized, body('bounded'), {
      fence: 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    expect(appended.itemId.length).toBeLessThan(2048)
    expect(appended.itemId).toContain('~orca-oversized~')

    const beforeTombstone = fixture.journal.cursor()
    await fixture.journal.appendTombstone(oversized, { fence: 1 })

    const created = readAgentSessionHistory(fixture.journal, {
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

    const removal = readAgentSessionHistory(fixture.journal, {
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
