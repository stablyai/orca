import { readTestJournalItems } from '../../../native-chat/agent-session-journal/journal-observation.test-support'
import { describe, expect, it } from 'vitest'

import { chat } from '../threads/codex-thread-catch-up-contract-test-fixture'

describe('codex turn lifecycle rows', () => {
  it('restores historical turn rows with optional endpoints in milliseconds', async () => {
    const c = await chat({ now: 1_800_000_000_000 })
    await c.open(
      [
        {
          id: 'turn-done',
          status: 'completed',
          startedAt: 1_700_000_000,
          completedAt: 1_700_000_042,
          durationMs: 41_900,
          items: [{ type: 'agentMessage', id: 'agent-done', text: 'done' }]
        },
        {
          id: 'turn-cut',
          status: 'interrupted',
          startedAt: 1_700_000_100,
          completedAt: 1_700_000_101,
          items: []
        },
        {
          id: 'turn-failed',
          status: 'failed',
          startedAt: 1_700_000_150,
          completedAt: 1_700_000_152,
          durationMs: 2_400,
          items: []
        },
        {
          id: 'turn-unplaced',
          status: 'someFutureStatus',
          startedAt: 1_700_000_170,
          completedAt: 1_700_000_171,
          items: []
        },
        { id: 'turn-open', status: 'inProgress', startedAt: 1_700_000_200, items: [] },
        { id: 'turn-untimed', status: 'completed', items: [] }
      ].map((turn) => ({ ...turn, itemsView: 'full' }))
    )

    expect(
      (await readTestJournalItems(c.journal)).map(({ itemId, body }) => ({ key: itemId, body }))
    ).toEqual([
      {
        key: 'legacy:codex:session-codex-catch-up:turn-lifecycle%3Aturn-done',
        body: {
          kind: 'turn',
          turnId: 'turn-done',
          state: 'completed',
          outcome: 'success',
          startedAt: 1_700_000_000_000,
          completedAt: 1_700_000_042_000,
          durationMs: 41_900
        }
      },
      expect.objectContaining({ body: expect.objectContaining({ kind: 'message' }) }),
      {
        key: 'legacy:codex:session-codex-catch-up:turn-lifecycle%3Aturn-cut',
        body: {
          kind: 'turn',
          turnId: 'turn-cut',
          state: 'interrupted',
          outcome: 'cancellation',
          startedAt: 1_700_000_100_000,
          completedAt: 1_700_000_101_000
        }
      },
      {
        key: 'legacy:codex:session-codex-catch-up:turn-lifecycle%3Aturn-failed',
        body: {
          kind: 'turn',
          turnId: 'turn-failed',
          state: 'completed',
          outcome: 'failure',
          startedAt: 1_700_000_150_000,
          completedAt: 1_700_000_152_000,
          durationMs: 2_400
        }
      },
      {
        key: 'legacy:codex:session-codex-catch-up:turn-lifecycle%3Aturn-unplaced',
        body: {
          kind: 'turn',
          turnId: 'turn-unplaced',
          state: 'completed',
          startedAt: 1_700_000_170_000,
          completedAt: 1_700_000_171_000
        }
      },
      {
        key: 'legacy:codex:session-codex-catch-up:turn-lifecycle%3Aturn-open',
        body: {
          kind: 'turn',
          turnId: 'turn-open',
          state: 'completed',
          startedAt: 1_700_000_200_000
        }
      },
      {
        key: 'legacy:codex:session-codex-catch-up:turn-lifecycle%3Aturn-untimed',
        body: {
          kind: 'turn',
          turnId: 'turn-untimed',
          state: 'completed',
          outcome: 'success'
        }
      }
    ])
    const rows = await readTestJournalItems(c.journal)
    for (const row of rows) {
      expect(await c.journal.reads.presentationRemoved(row.itemId)).toBe(false)
    }
    await c.reopen()
    expect(await readTestJournalItems(c.journal)).toEqual(rows)
  })
})
