import { describe, expect, it } from 'vitest'
import { readAgentSessionHistory } from '../agent-session-history-page'
import { fixture, appendItems, item } from './agent-session-history-contract-test-fixture'

describe('readAgentSessionHistory', () => {
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
})
