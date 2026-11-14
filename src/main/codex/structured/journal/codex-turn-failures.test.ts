import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import {
  LIFECYCLE_KEY,
  THREAD_ID,
  TURN_ID,
  notification,
  recorder,
  reduced,
  translatorFor
} from './codex-turn-lifecycle-contract-test-fixture'

const DIAGNOSTIC = 'Provider diagnostic: internal request failure'

function error(code: unknown, extra: Record<string, unknown> = {}) {
  return {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    willRetry: false,
    error: { message: DIAGNOSTIC, codexErrorInfo: code },
    ...extra
  }
}

function statuses(tap: ReturnType<typeof recorder>) {
  return reduced(tap.rows).flatMap((row) =>
    row.body.kind === 'status' && row.body.failure?.kind !== 'providerRetrying' ? [row.body] : []
  )
}

describe('Codex terminal failure categories', () => {
  it('ends a recorded-shape failed completion carrying an unknown future code', () => {
    const frames: {
      case: string
      method: string
      params: {
        threadId: string
        turn?: { id: string; status: string; error?: Record<string, unknown> }
      }
    }[] = readFileSync(
      join(__dirname, '../../__fixtures__/codex-app-server-turn-endings.jsonl'),
      'utf8'
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const captured = frames.find(
      (frame) => frame.case === '0.141.0-conn-refused' && frame.method === 'turn/completed'
    )
    if (!captured?.params.turn) {
      throw new Error('Missing captured failed completion')
    }
    const tap = recorder()
    const translator = createCodexJournalTranslator({
      sink: tap.sink,
      sessionId: 'session-1',
      primaryThreadId: () => captured.params.threadId
    })
    const on = (method: string, params: unknown) =>
      translator.handle({
        type: 'notification',
        sessionId: 'session-1',
        threadId: captured.params.threadId,
        method,
        params
      })
    on('turn/started', { turn: { id: captured.params.turn.id } })
    expect(reduced(tap.rows).map((row) => row.body)).toMatchObject([
      { kind: 'turn', state: 'running' }
    ])
    expect(
      on('turn/completed', {
        ...captured.params,
        turn: {
          ...captured.params.turn,
          error: { ...captured.params.turn.error, codexErrorInfo: 'futureFailureAfter0167' }
        }
      })
    ).toEqual({ accepted: true })
    expect(reduced(tap.rows).map((row) => row.body)).toMatchObject([
      { kind: 'turn', state: 'completed', outcome: 'failure' },
      { kind: 'status', failure: { kind: 'providerResponseFailed' } }
    ])
  })

  it('shows a completion-only safety stop while preserving an ordinary Stop', () => {
    for (const error of [{ message: DIAGNOSTIC, codexErrorInfo: 'tooManyDenials' }, null]) {
      const tap = recorder()
      const translator = translatorFor(tap)
      translator.handle(notification('turn/started', { turn: { id: TURN_ID } }))
      translator.handle(
        notification('turn/completed', { turn: { id: TURN_ID, status: 'interrupted', error } })
      )
      expect(reduced(tap.rows).find((row) => row.key === LIFECYCLE_KEY)?.body).toMatchObject({
        kind: 'turn',
        state: 'interrupted',
        outcome: 'cancellation'
      })
      expect(statuses(tap)).toMatchObject(
        error ? [{ failure: { kind: 'providerSafetyStopped' } }] : []
      )
    }
  })

  it('keeps completion-only sign-in diagnostics behind Details', () => {
    const tap = recorder()
    const translator = translatorFor(tap)
    translator.handle(notification('turn/started', { turn: { id: TURN_ID } }))
    translator.handle(
      notification('turn/completed', {
        turn: {
          id: TURN_ID,
          status: 'failed',
          error: error({ responseStreamDisconnected: { httpStatusCode: 401 } }).error
        }
      })
    )
    expect(statuses(tap)).toMatchObject([{ failure: { kind: 'notSignedIn' } }])
    expect(statuses(tap)[0]?.text).not.toContain(DIAGNOSTIC)
    expect(statuses(tap)[0]?.providerFrame?.payload.head).toContain(DIAGNOSTIC)
  })

  it('keeps recovered sign-in advice through completion backpressure without another failure row', () => {
    const tap = recorder()
    let rejectCompletion = true
    tap.sink.tryAppendItem = (identity, body, options) => {
      if (body.kind === 'turn' && body.state === 'completed' && rejectCompletion) {
        rejectCompletion = false
        return { accepted: false, reason: 'backpressure' }
      }
      tap.sink.appendItem(identity, body, options)
      return { accepted: true }
    }
    const translator = translatorFor(tap)
    translator.handle(notification('turn/started', { turn: { id: TURN_ID } }))
    translator.handle(
      notification('error', {
        ...error({ responseStreamDisconnected: { httpStatusCode: 401 } }, { willRetry: true }),
        error: {
          message: 'Reconnecting... 1/2',
          codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 401 } },
          additionalDetails: DIAGNOSTIC
        }
      })
    )
    translator.handle(notification('error', error('other')))
    const completion = notification('turn/completed', {
      turn: { id: TURN_ID, status: 'failed', error: error('other').error }
    })
    expect(translator.handle(completion)).toEqual({ accepted: false, reason: 'backpressure' })
    expect(translator.handle(completion)).toEqual({ accepted: true })
    const terminal = tap.rows.filter(
      (row) => row.body.kind === 'status' && row.body.failure?.kind !== 'providerRetrying'
    )
    expect(terminal.map((row) => row.body)).toMatchObject([{ failure: { kind: 'notSignedIn' } }])
    expect(statuses(tap)[0]?.text).not.toContain(DIAGNOSTIC)
    expect(statuses(tap)[0]?.providerFrame?.payload.head).toContain(DIAGNOSTIC)
    expect(reduced(tap.rows).find((row) => row.key === LIFECYCLE_KEY)?.body).toMatchObject({
      state: 'completed',
      outcome: 'failure'
    })
  })

  it('uses the last non-other retry only for matching text and scope, including empty details', () => {
    const tap = recorder()
    const translator = translatorFor(tap)
    const retry = (code: unknown, details: string) =>
      notification('error', {
        ...error(code, { willRetry: true }),
        error: { message: DIAGNOSTIC, codexErrorInfo: code, additionalDetails: details }
      })
    translator.handle(retry({ responseStreamDisconnected: { httpStatusCode: 401 } }, ''))
    translator.handle(notification('error', error('other')))
    expect(statuses(tap).at(-1)?.failure?.kind).toBe('providerResponseFailed')
    translator.handle(retry({ responseStreamDisconnected: { httpStatusCode: 401 } }, DIAGNOSTIC))
    translator.handle(retry('futureRetryCode', DIAGNOSTIC))
    translator.handle(notification('error', error('other')))
    expect(statuses(tap).at(-1)?.failure?.kind).toBe('providerResponseFailed')
    translator.handle(retry({ responseStreamDisconnected: { httpStatusCode: 401 } }, DIAGNOSTIC))
    translator.handle(notification('error', error('other', { turnId: 'another-turn' })))
    expect(statuses(tap).at(-1)?.failure?.kind).toBe('providerResponseFailed')
  })
})
