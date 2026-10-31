import { describe, expect, it, vi } from 'vitest'
import {
  readAgentJournalTurn,
  readAgentJournalTurnOutcome
} from '../../shared/agent-session-turn-record'
import type { CodexAppServerConnection } from './app-server/codex-app-server-connection-types'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import { createCodexStructuredNotificationRetry } from './codex-structured-notification-retry'
import type { CodexSession } from './codex-structured-session-state'

import {
  LIFECYCLE_KEY,
  SESSION_ID,
  THREAD_ID,
  TURN_ID,
  USER_ITEM_ID,
  notification,
  recorder,
  reduced,
  translatorFor
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

  it('carries the provider duration and the same user item onto the terminal row', () => {
    const tap = recorder()
    const translator = translatorFor(tap)

    translator.handle(notification('turn/started', { turn: { id: TURN_ID } }, 1_000))
    translator.handle(
      notification(
        'turn/completed',
        { turn: { id: TURN_ID, status: 'completed', durationMs: 3_250 } },
        4_500
      )
    )

    expect(tap.rows.at(-1)).toEqual({
      key: LIFECYCLE_KEY,
      body: {
        kind: 'turn',
        turnId: TURN_ID,
        state: 'completed',
        outcome: 'success',
        userItemId: USER_ITEM_ID,
        startedAt: 1_000,
        completedAt: 4_500,
        durationMs: 3_250
      }
    })
  })

  it.each([
    ['interrupted', 'interrupted', 'cancellation'],
    ['failed', 'completed', 'failure'],
    ['someFutureStatus', 'completed', undefined],
    ['inProgress', 'completed', undefined]
  ] as const)(
    'maps a %s turn status to a %s lifecycle with outcome %s',
    (status, state, outcome) => {
      const tap = recorder()
      const translator = translatorFor(tap)

      translator.handle(notification('turn/started', { turn: { id: TURN_ID } }, 1_000))
      translator.handle(notification('turn/completed', { turn: { id: TURN_ID, status } }, 2_000))

      expect(tap.tombstones).toEqual([])
      expect(reduced(tap.rows)).toEqual([
        {
          key: LIFECYCLE_KEY,
          body: {
            kind: 'turn',
            turnId: TURN_ID,
            state,
            ...(outcome ? { outcome } : {}),
            userItemId: USER_ITEM_ID,
            startedAt: 1_000,
            completedAt: 2_000
          }
        }
      ])
    }
  )

  it('records no outcome for a turn end that named no status', () => {
    const tap = recorder()
    const translator = translatorFor(tap)

    translator.handle(notification('turn/started', { turn: { id: TURN_ID } }, 1_000))
    translator.handle(notification('turn/completed', { turn: { id: TURN_ID } }, 2_000))

    const body = reduced(tap.rows).at(-1)?.body
    expect(body).toMatchObject({ kind: 'turn', state: 'completed' })
    expect(readAgentJournalTurnOutcome(readAgentJournalTurn(body))).toBeNull()
  })

  it('stamps the host clock when a boundary arrives without a receipt time', () => {
    const tap = recorder()
    let clock = 10_000
    const translator = translatorFor(tap, () => (clock += 250))

    translator.handle(notification('turn/started', { turn: { id: TURN_ID } }))
    translator.handle(notification('turn/completed', { turn: { id: TURN_ID } }))

    expect(tap.rows.map((row) => row.body)).toMatchObject([
      { kind: 'turn', state: 'running', startedAt: 10_250 },
      { kind: 'turn', state: 'completed', startedAt: 10_250, completedAt: 10_500 }
    ])
  })

  it('writes only the end time, and no duration, when Codex reports neither', () => {
    const tap = recorder()
    const translator = translatorFor(tap)

    translator.handle(notification('turn/completed', { turn: { id: TURN_ID } }, 3_000))

    expect(tap.rows).toEqual([
      {
        key: LIFECYCLE_KEY,
        body: {
          kind: 'turn',
          turnId: TURN_ID,
          state: 'completed',
          userItemId: USER_ITEM_ID,
          completedAt: 3_000
        }
      }
    ])
  })

  it('replays an oversized backpressured notification with its original receipt time', async () => {
    vi.useFakeTimers()
    const connection = {
      pauseReading: vi.fn(),
      resumeReading: vi.fn()
    } as unknown as CodexAppServerConnection
    const translate = vi
      .fn<Parameters<typeof createCodexStructuredNotificationRetry>[0]['translate']>()
      .mockReturnValueOnce({ accepted: false, reason: 'backpressure' })
      .mockReturnValue({ accepted: true })
    const retries = createCodexStructuredNotificationRetry({
      sessionFor: () => ({ connection, ended: false }) as CodexSession,
      translate
    })

    expect(
      retries.handle(
        SESSION_ID,
        'turn/started',
        { turn: { id: TURN_ID }, output: 'x'.repeat(9 * 1024 * 1024) },
        1_000,
        -1
      )
    ).toEqual({ accepted: false, reason: 'backpressure' })
    await vi.advanceTimersByTimeAsync(50)

    expect(translate.mock.calls.map((call) => call[4])).toEqual([1_000, 1_000])
    expect(translate.mock.calls.map((call) => call[5])).toEqual([-1, -1])
    expect(connection.resumeReading).not.toHaveBeenCalled()
  })
})
