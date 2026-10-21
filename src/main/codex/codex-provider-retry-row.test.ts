import {
  acquireReadyCodexForTest,
  adapterFor,
  fakeCodex,
  identityFor
} from './codex-structured-session-adapter-fixture'
// A Codex stream error it is about to retry is a warning row per attempt, never a red row: the
// journal keeps every attempt, and the transcript draws only the latest of a run.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import type { CodexStructuredSessionEvent } from './codex-structured-session-adapter'

const THREAD_ID = 'thread-abc'
const TURN_ID = 'turn-1'
const CAPTURED_THREAD = '00000000-0000-7000-8000-000000000012'

type Row = { key: string; body: AgentJournalItemBody }

function harness() {
  const rows: Row[] = []
  let publishes = 0
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (identity: AgentJournalItemIdentity, body) =>
      rows.push({ key: agentJournalItemKey(identity), body }),
    appendTombstone: () => undefined,
    publish: () => {
      publishes += 1
    }
  }
  const translator = createCodexJournalTranslator({ sink, primaryThreadId: () => THREAD_ID })
  translator.handle(notification('turn/started', { turn: { id: TURN_ID } }))
  return { translator, rows, publishes: () => publishes }
}

/** Latest body per identity, in first-seen order: what the journal reducer keeps. */
function reduced(rows: readonly Row[]): Row[] {
  const latest = new Map<string, Row>()
  for (const row of rows) {
    latest.set(row.key, row)
  }
  return [...latest.values()]
}

function notification(method: string, params: unknown): CodexStructuredSessionEvent {
  return { type: 'notification', sessionId: 'session-1', threadId: THREAD_ID, method, params }
}

/** The params the app server sends for a stream error it is about to retry. */
function retryParams(message: string, additionalDetails?: string) {
  return {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    willRetry: true,
    error: {
      message,
      codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } },
      ...(additionalDetails !== undefined ? { additionalDetails } : {})
    }
  }
}

function retrying(message: string, additionalDetails?: string) {
  return notification('error', retryParams(message, additionalDetails))
}

function retryRows(rows: readonly Row[]): Row[] {
  return reduced(rows).filter(
    (row) => row.body.kind === 'status' && row.body.failure?.kind === 'providerRetrying'
  )
}

describe('a Codex stream error it is about to retry', () => {
  it('writes its own warning row for every attempt', () => {
    const { translator, rows } = harness()

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      translator.handle(retrying(`Reconnecting... ${attempt}/5`, 'stream disconnected'))
    }

    const written = retryRows(rows)
    expect(written).toHaveLength(3)
    expect(new Set(written.map((row) => row.key)).size).toBe(3)
    expect(written.map((row) => row.body.kind === 'status' && row.body.text)).toEqual([
      'Codex is retrying: Reconnecting... 1/5.\nstream disconnected',
      'Codex is retrying: Reconnecting... 2/5.\nstream disconnected',
      'Codex is retrying: Reconnecting... 3/5.\nstream disconnected'
    ])
    expect(written[2]?.body).toEqual({
      kind: 'status',
      tone: 'warning',
      text: 'Codex is retrying: Reconnecting... 3/5.\nstream disconnected',
      failure: {
        kind: 'providerRetrying',
        detail: { text: 'Reconnecting... 3/5', audience: 'person' },
        retry: { error: 'responseStreamDisconnected', status: 502, cause: 'stream disconnected' }
      },
      providerFrame: {
        provider: 'codex',
        kind: 'notification:error',
        payload: expect.objectContaining({ head: expect.stringContaining('Reconnecting... 3/5') })
      }
    })
    // No row revises another: each attempt was written once.
    expect(rows.filter((row) => written.some((retry) => retry.key === row.key))).toHaveLength(3)
    expect(
      reduced(rows).filter((row) => row.body.kind === 'status' && row.body.tone === 'error')
    ).toEqual([])
  })

  it('is one line when Codex gives no detail, or only repeats its message', () => {
    const { translator, rows } = harness()
    translator.handle(retrying('Reconnecting... 1/5'))
    translator.handle(retrying('Reconnecting... 2/5', 'Reconnecting... 2/5'))

    expect(retryRows(rows).map((row) => row.body.kind === 'status' && row.body.text)).toEqual([
      'Codex is retrying: Reconnecting... 1/5.',
      'Codex is retrying: Reconnecting... 2/5.'
    ])
  })

  it('publishes every attempt, so each one renews the idle clock', () => {
    const { translator, publishes } = harness()

    const before = publishes()
    translator.handle(retrying('Reconnecting... 1/5'))
    translator.handle(retrying('Reconnecting... 2/5'))
    translator.handle(retrying('Reconnecting... 3/5'))

    expect(publishes() - before).toBe(3)
  })

  it('keeps every earlier row when a new connection in the same session retries', () => {
    const rows: Row[] = []
    const connect = (acquisitionId: string) => {
      const translator = createCodexJournalTranslator({
        sink: {
          appendItem: (identity, body) => rows.push({ key: agentJournalItemKey(identity), body }),
          appendTombstone: () => undefined,
          publish: () => undefined
        },
        primaryThreadId: () => THREAD_ID,
        acquisitionId
      })
      translator.handle(notification('turn/started', { turn: { id: TURN_ID } }))
      return translator
    }
    const first = connect('generation-1')
    first.handle(retrying('Reconnecting... 1/5'))
    first.handle(retrying('Reconnecting... 2/5'))
    const second = connect('generation-2')
    second.handle(retrying('Reconnecting... 1/5'))

    // Each write is a new row: nothing the first connection wrote is revised.
    expect(retryRows(rows).map((row) => row.body.kind === 'status' && row.body.text)).toEqual([
      'Codex is retrying: Reconnecting... 1/5.',
      'Codex is retrying: Reconnecting... 2/5.',
      'Codex is retrying: Reconnecting... 1/5.'
    ])
  })

  it('is named for the acquisition that received it, so a reconnect writes new rows', async () => {
    const codex = fakeCodex()
    const adapter = adapterFor(codex)
    const rows: Row[] = []
    const events: StructuredAgentSessionEventSink = {
      appendItem: (identity, body) => rows.push({ key: agentJournalItemKey(identity), body }),
      appendTombstone: () => undefined,
      publish: () => undefined
    }
    for (const fence of [7, 8]) {
      await acquireReadyCodexForTest(adapter, {
        identity: identityFor('session-1'),
        fence,
        spawnToken: `spawn-${fence}`,
        events
      })
      codex.connections
        .at(-1)
        ?.handlers.onNotification?.('error', retryParams('Reconnecting... 1/5'))
    }

    expect(codex.connections).toHaveLength(2)
    expect(retryRows(rows)).toHaveLength(2)
  })

  it('leaves the error Codex gives up on as the red row, and the turn fails, in a captured run', () => {
    const captured = readFileSync(
      join(__dirname, '__fixtures__', 'codex-app-server-turn-endings.jsonl'),
      'utf8'
    )
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line): { case: string; method: string; params: unknown } => JSON.parse(line))
      .filter((frame) => frame.case === '0.141.0-conn-refused')
    const rows: Row[] = []
    const translator = createCodexJournalTranslator({
      sink: {
        appendItem: (identity, body) => rows.push({ key: agentJournalItemKey(identity), body }),
        appendTombstone: () => undefined,
        publish: () => undefined
      },
      primaryThreadId: () => CAPTURED_THREAD
    })
    for (const frame of captured) {
      translator.handle({
        type: 'notification',
        sessionId: 'session-1',
        threadId: CAPTURED_THREAD,
        method: frame.method,
        params: frame.params
      })
    }

    const cause =
      'stream disconnected before completion: error sending request for url (http://127.0.0.1:9/v1/responses)'
    const errorFrameRows = reduced(rows).flatMap((row) =>
      row.body.kind === 'status' && row.body.providerFrame?.kind === 'notification:error'
        ? [{ tone: row.body.tone, text: row.body.text }]
        : []
    )
    expect(errorFrameRows).toEqual([
      { tone: 'warning', text: `Codex is retrying: Reconnecting... 1/2.\n${cause}` },
      { tone: 'warning', text: `Codex is retrying: Reconnecting... 2/2.\n${cause}` },
      { tone: 'error', text: cause }
    ])
    expect(reduced(rows).map((row) => row.body)).toContainEqual(
      expect.objectContaining({ kind: 'turn', state: 'completed', outcome: 'failure' })
    )
  })
})
