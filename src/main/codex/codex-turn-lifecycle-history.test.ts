import { describe, expect, it } from 'vitest'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'

import { THREAD_ID, recorder, translatorFor } from './codex-turn-lifecycle-contract-test-fixture'

describe('codex turn lifecycle rows', () => {
  it('restores historical turn rows with optional endpoints in milliseconds', () => {
    const tap = recorder()
    const translator = translatorFor(tap)

    expect(
      translator.restoreThread(THREAD_ID, {
        turns: [
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
        ]
      })
    ).toEqual({ accepted: true })

    expect(tap.rows).toEqual([
      {
        key: 'legacy:codex:session-1:turn-lifecycle%3Aturn-done',
        body: {
          kind: 'turn',
          turnId: 'turn-done',
          state: 'completed',
          outcome: 'success',
          userItemId: 'codex:thread-abc:turn-done:0',
          startedAt: 1_700_000_000_000,
          completedAt: 1_700_000_042_000,
          durationMs: 41_900
        }
      },
      expect.objectContaining({ body: expect.objectContaining({ kind: 'message' }) }),
      {
        key: 'legacy:codex:session-1:turn-lifecycle%3Aturn-cut',
        body: {
          kind: 'turn',
          turnId: 'turn-cut',
          state: 'interrupted',
          outcome: 'cancellation',
          userItemId: 'codex:thread-abc:turn-cut:0',
          startedAt: 1_700_000_100_000,
          completedAt: 1_700_000_101_000
        }
      },
      {
        key: 'legacy:codex:session-1:turn-lifecycle%3Aturn-failed',
        body: {
          kind: 'turn',
          turnId: 'turn-failed',
          state: 'completed',
          outcome: 'failure',
          userItemId: 'codex:thread-abc:turn-failed:0',
          startedAt: 1_700_000_150_000,
          completedAt: 1_700_000_152_000,
          durationMs: 2_400
        }
      },
      {
        key: 'legacy:codex:session-1:turn-lifecycle%3Aturn-unplaced',
        body: {
          kind: 'turn',
          turnId: 'turn-unplaced',
          state: 'completed',
          userItemId: 'codex:thread-abc:turn-unplaced:0',
          startedAt: 1_700_000_170_000,
          completedAt: 1_700_000_171_000
        }
      },
      {
        key: 'legacy:codex:session-1:turn-lifecycle%3Aturn-open',
        body: {
          kind: 'turn',
          turnId: 'turn-open',
          state: 'completed',
          userItemId: 'codex:thread-abc:turn-open:0',
          startedAt: 1_700_000_200_000
        }
      },
      {
        key: 'legacy:codex:session-1:turn-lifecycle%3Aturn-untimed',
        body: {
          kind: 'turn',
          turnId: 'turn-untimed',
          state: 'completed',
          outcome: 'success',
          userItemId: 'codex:thread-abc:turn-untimed:0'
        }
      }
    ])
    expect(tap.tombstones).toEqual([])
  })

  it('restores no lifecycle rows without a session identity to key them by', () => {
    const tap = recorder()
    const translator = createCodexJournalTranslator({
      sink: tap.sink,
      primaryThreadId: () => THREAD_ID
    })

    translator.restoreThread(THREAD_ID, {
      turns: [{ id: 'turn-done', status: 'completed', startedAt: 1, completedAt: 2, items: [] }]
    })

    expect(tap.rows).toEqual([])
  })
})
