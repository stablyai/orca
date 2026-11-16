import { describe, expect, it, vi } from 'vitest'

import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import {
  CODEX_COMMAND_APPROVAL_METHOD,
  CODEX_USER_INPUT_METHOD
} from '../prompts/codex-prompt-registry'
import {
  LIFECYCLE_KEY,
  reduced,
  SESSION_ID,
  THREAD_ID,
  TURN_ID,
  notification,
  recorder
} from './codex-turn-lifecycle-contract-test-fixture'

import '../prompts/codex-structured-prompt-replies'

describe('codex turn lifecycle rows', () => {
  it('settles prompts when a turn completes while awaiting approval', () => {
    const tap = recorder()
    const clearPromptTurn = vi.fn()
    const translator = createCodexJournalTranslator({
      sink: tap.sink,
      primaryThreadId: () => THREAD_ID,
      clearPromptTurn
    })

    translator.handle(notification('turn/started', { turn: { id: TURN_ID } }))
    translator.handle({
      type: 'prompt',
      sessionId: SESSION_ID,
      threadId: THREAD_ID,
      method: CODEX_COMMAND_APPROVAL_METHOD,
      params: { turnId: TURN_ID, availableDecisions: ['accept', 'decline'] },
      codexItemId: 'exec-cancelled',
      promptKey: 'approval-cancelled'
    })

    expect(translator.handle(notification('turn/completed', { turn: { id: TURN_ID } }))).toEqual({
      accepted: true
    })
    expect(tap.rows.map((row) => row.body)).toEqual([
      expect.objectContaining({ kind: 'turn', state: 'running' }),
      expect.objectContaining({
        kind: 'approval',
        resolution: expect.objectContaining({ state: 'pending' })
      }),
      expect.objectContaining({
        kind: 'approval',
        resolution: expect.objectContaining({ state: 'cancelled' })
      }),
      expect.objectContaining({ kind: 'turn', state: 'completed' })
    ])
    expect(clearPromptTurn).toHaveBeenCalledWith(THREAD_ID, TURN_ID)
  })

  it('settles questions when a turn completes while awaiting input', () => {
    const tap = recorder()
    const clearPromptTurn = vi.fn()
    const translator = createCodexJournalTranslator({
      sink: tap.sink,
      primaryThreadId: () => THREAD_ID,
      clearPromptTurn
    })

    translator.handle(notification('turn/started', { turn: { id: TURN_ID } }))
    translator.handle({
      type: 'prompt',
      sessionId: SESSION_ID,
      threadId: THREAD_ID,
      method: CODEX_USER_INPUT_METHOD,
      params: {
        turnId: TURN_ID,
        questions: [
          { id: 'question-cancelled', question: 'Continue?', options: [{ label: 'yes' }] }
        ]
      },
      codexItemId: 'exec-question-cancelled',
      promptKey: 'question-cancelled'
    })

    expect(translator.handle(notification('turn/completed', { turn: { id: TURN_ID } }))).toEqual({
      accepted: true
    })
    expect(tap.rows.map((row) => row.body)).toEqual([
      expect.objectContaining({ kind: 'turn', state: 'running' }),
      expect.objectContaining({
        kind: 'question',
        resolution: expect.objectContaining({ state: 'pending' })
      }),
      expect.objectContaining({
        kind: 'question',
        resolution: expect.objectContaining({ state: 'cancelled' })
      }),
      expect.objectContaining({ kind: 'turn', state: 'completed' })
    ])
    expect(clearPromptTurn).toHaveBeenCalledWith(THREAD_ID, TURN_ID)
  })

  it('settles an echoed send only after its request-origin revision is admitted', () => {
    const tap = recorder()
    let rejectOrigin = true
    tap.sink.tryAppendItem = (identity, body, blobs) => {
      if (body.kind === 'turn' && body.requestedAt !== undefined && rejectOrigin) {
        return { accepted: false, reason: 'backpressure' }
      }
      tap.sink.appendItem(identity, body, blobs)
      return { accepted: true }
    }
    const onUserMessageEcho = vi.fn()
    const translator = createCodexJournalTranslator({
      sink: tap.sink,
      sessionId: SESSION_ID,
      primaryThreadId: () => THREAD_ID,
      dispatchRequestOrigin: () => ({ requestedAt: 900, sequence: 0 }),
      onUserMessageEcho
    })
    const echo = notification(
      'item/started',
      {
        turn: { id: TURN_ID },
        item: { type: 'userMessage', id: 'user-1', clientId: 'client-1' }
      },
      1_100
    )

    translator.handle(notification('turn/started', { turn: { id: TURN_ID } }, 1_000))
    expect(translator.handle(echo)).toEqual({ accepted: false, reason: 'backpressure' })
    expect(onUserMessageEcho).not.toHaveBeenCalled()
    expect(tap.rows.map((row) => row.body)).toEqual([
      expect.objectContaining({ kind: 'turn', state: 'running', startedAt: 1_000 })
    ])

    rejectOrigin = false
    expect(translator.handle(echo)).toEqual({ accepted: true })
    expect(onUserMessageEcho).toHaveBeenCalledOnce()
    expect(onUserMessageEcho).toHaveBeenCalledWith(
      'client-1',
      expect.objectContaining({ provider: 'codex', threadId: THREAD_ID, turnId: TURN_ID })
    )
    expect(tap.rows.at(-1)?.body).toMatchObject({
      kind: 'turn',
      state: 'running',
      startedAt: 1_000,
      requestedAt: 900
    })
  })

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
