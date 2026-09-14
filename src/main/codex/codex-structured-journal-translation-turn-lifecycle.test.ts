import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { createTrackedJournalOpener } from '../native-chat/agent-session-journal/journal-store-test-open'
import {
  createDeferredStructuredAgentSessionEventSink,
  type StructuredAgentSessionEventSink
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { CodexAppServerConnection } from './codex-app-server-connection'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import { createCodexStructuredNotificationRetry } from './codex-structured-notification-retry'
import type { CodexStructuredSessionEvent } from './codex-structured-session-adapter'
import type { CodexSession } from './codex-structured-session-state'

const SESSION_ID = 'session-1'
const THREAD_ID = 'thread-abc'
const TURN_ID = 'turn-1'
const LIFECYCLE_KEY = 'legacy:codex:session-1:turn-lifecycle%3Aturn-1'
const USER_ITEM_ID = 'codex:thread-abc:turn-1:0'

type Row = { key: string; body: AgentJournalItemBody }

function recorder() {
  const rows: Row[] = []
  const tombstones: string[] = []
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (identity: AgentJournalItemIdentity, body) =>
      rows.push({ key: agentJournalItemKey(identity), body }),
    appendTombstone: (identity) => tombstones.push(agentJournalItemKey(identity)),
    publish: () => {}
  }
  return { sink, rows, tombstones }
}

/** Latest body per identity, in first-seen order: what the journal reducer keeps. */
function reduced(rows: readonly Row[]): Row[] {
  const latest = new Map<string, Row>()
  for (const row of rows) {
    latest.set(row.key, row)
  }
  return [...latest.values()]
}

function notification(
  method: string,
  params: unknown,
  observedAt?: number
): CodexStructuredSessionEvent {
  return {
    type: 'notification',
    sessionId: SESSION_ID,
    threadId: THREAD_ID,
    method,
    params,
    ...(observedAt !== undefined ? { observedAt } : {})
  }
}

function translatorFor(tap: ReturnType<typeof recorder>, now?: () => number) {
  return createCodexJournalTranslator({
    sink: tap.sink,
    sessionId: SESSION_ID,
    primaryThreadId: () => THREAD_ID,
    ...(now ? { now } : {})
  })
}

const journals = createTrackedJournalOpener()
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-codex-turn-lifecycle-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
  vi.useRealTimers()
})

describe('codex turn lifecycle rows', () => {
  it('opens the running row with the host receipt time and pins the row time to it', async () => {
    const journal = await journals.open({
      identity: {
        sessionId: SESSION_ID,
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'codex',
        providerHandle: { kind: 'codex', threadId: THREAD_ID }
      },
      now: () => 9_000,
      journalDir: join(root, SESSION_ID)
    })
    const deferred = createDeferredStructuredAgentSessionEventSink()
    const translator = createCodexJournalTranslator({
      sink: deferred.sink,
      sessionId: SESSION_ID,
      primaryThreadId: () => THREAD_ID
    })
    deferred.bind({ journal, fence: 1, publish: () => {} })
    const before = journal.cursor()

    translator.handle(notification('turn/started', { turn: { id: TURN_ID } }, 1_000))
    await expect(deferred.drained()).resolves.toEqual({ ok: true })

    const appended = journal.readSince(before)
    expect(appended.ok && appended.rows).toEqual([
      expect.objectContaining({
        kind: 'item',
        v: 3,
        ts: 1_000,
        body: {
          kind: 'turn',
          turnId: TURN_ID,
          state: 'running',
          userItemId: USER_ITEM_ID,
          startedAt: 1_000
        }
      })
    ])
    expect(journal.snapshot().items).toEqual([
      expect.objectContaining({
        observedAt: 1_000,
        body: {
          kind: 'turn',
          turnId: TURN_ID,
          state: 'running',
          userItemId: USER_ITEM_ID,
          startedAt: 1_000
        }
      })
    ])
    deferred.close()
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
        userItemId: USER_ITEM_ID,
        startedAt: 1_000,
        completedAt: 4_500,
        durationMs: 3_250
      }
    })
  })

  it.each(['interrupted', 'failed', 'cancelled'])(
    'maps a %s turn status to an interrupted lifecycle',
    (status) => {
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
            state: 'interrupted',
            userItemId: USER_ITEM_ID,
            startedAt: 1_000,
            completedAt: 2_000
          }
        }
      ])
    }
  )

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

  it('replays a backpressured turn boundary with its original receipt time', async () => {
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

    expect(retries.handle(SESSION_ID, 'turn/started', { turn: { id: TURN_ID } }, 1_000)).toEqual({
      accepted: false,
      reason: 'backpressure'
    })
    await vi.advanceTimersByTimeAsync(50)

    expect(translate.mock.calls.map((call) => call[4])).toEqual([1_000, 1_000])
    expect(connection.resumeReading).not.toHaveBeenCalled()
  })

  it('restores terminal rows for historical turns with both endpoints, in milliseconds', () => {
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
          { id: 'turn-open', status: 'inProgress', startedAt: 1_700_000_200, items: [] },
          { id: 'turn-untimed', status: 'completed', items: [] }
        ]
      })
    ).toEqual({ accepted: true })

    expect(tap.rows).toEqual([
      expect.objectContaining({ body: expect.objectContaining({ kind: 'message' }) }),
      {
        key: 'legacy:codex:session-1:turn-lifecycle%3Aturn-done',
        body: {
          kind: 'turn',
          turnId: 'turn-done',
          state: 'completed',
          userItemId: 'codex:thread-abc:turn-done:0',
          startedAt: 1_700_000_000_000,
          completedAt: 1_700_000_042_000,
          durationMs: 41_900
        }
      },
      {
        key: 'legacy:codex:session-1:turn-lifecycle%3Aturn-cut',
        body: {
          kind: 'turn',
          turnId: 'turn-cut',
          state: 'interrupted',
          userItemId: 'codex:thread-abc:turn-cut:0',
          startedAt: 1_700_000_100_000,
          completedAt: 1_700_000_101_000
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
