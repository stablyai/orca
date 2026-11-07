import { describe, expect, it } from 'vitest'

import { createCodexJournalTranslator } from './codex-structured-journal-translation'

import {
  LIFECYCLE_KEY,
  SESSION_ID,
  THREAD_ID,
  TURN_ID,
  notification,
  recorder,
  reduced
} from './codex-turn-lifecycle-contract-test-fixture'

describe('codex turn lifecycle rows', () => {
  it('keeps the verdict when a send echoed after completion revises the settled row', () => {
    const tap = recorder()
    const translator = createCodexJournalTranslator({
      sink: tap.sink,
      sessionId: SESSION_ID,
      primaryThreadId: () => THREAD_ID,
      dispatchRequestOrigin: () => ({ requestedAt: 900, sequence: 0 })
    })

    translator.handle(notification('turn/started', { turn: { id: TURN_ID } }, 1_000))
    translator.handle(
      notification('turn/completed', { turn: { id: TURN_ID, status: 'failed' } }, 2_000)
    )
    translator.handle(
      notification(
        'item/started',
        {
          turn: { id: TURN_ID },
          item: { type: 'userMessage', id: 'user-1', clientId: 'client-1' }
        },
        2_100
      )
    )

    // requestedAt distinguishes the post-echo revision from the original terminal row.
    const lifecycle = reduced(tap.rows).find((row) => row.key === LIFECYCLE_KEY)
    expect(lifecycle?.body).toMatchObject({
      kind: 'turn',
      state: 'completed',
      outcome: 'failure',
      requestedAt: 900
    })
  })
})
