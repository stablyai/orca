import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createDeferredStructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import {
  CODEX_COMMAND_APPROVAL_METHOD,
  CODEX_USER_INPUT_METHOD,
  CodexPromptRegistry
} from './codex-structured-prompt-replies'
import { testEventSinkLogging } from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import { codexProviderHandle } from '../../shared/agent-session-provider-handle-encoding'

import {
  fixture,
  SESSION_ID,
  THREAD_ID,
  TURN_ID,
  USER_ITEM_ID,
  journals,
  notification,
  recorder
} from './codex-turn-lifecycle-contract-test-fixture'

describe('codex turn lifecycle rows', () => {
  it('binds a prompt without a provider turn id to the active turn before cleanup', () => {
    const tap = recorder()
    const registry = new CodexPromptRegistry()
    registry.register({
      id: 1,
      method: CODEX_COMMAND_APPROVAL_METHOD,
      params: {
        itemId: 'exec-fallback',
        approvalId: 'approval-fallback',
        threadId: THREAD_ID
      }
    })
    const translator = createCodexJournalTranslator({
      sink: tap.sink,
      primaryThreadId: () => THREAD_ID,
      bindPromptItemId: (journalItemId, threadId, promptKey, turnId) =>
        registry.bindJournalItemId(journalItemId, threadId, promptKey, turnId),
      clearPromptTurn: (threadId, turnId) => registry.clearTurn(threadId, turnId)
    })

    translator.handle(notification('turn/started', { turn: { id: TURN_ID } }))
    translator.handle({
      type: 'prompt',
      sessionId: SESSION_ID,
      threadId: THREAD_ID,
      method: CODEX_COMMAND_APPROVAL_METHOD,
      params: { availableDecisions: ['accept', 'decline'] },
      codexItemId: 'exec-fallback',
      promptKey: 'approval-fallback'
    })

    expect(registry.find('approval-fallback')?.turnId).toBe(TURN_ID)
    translator.handle(notification('turn/completed', { turn: { id: TURN_ID } }))
    expect(registry.find('approval-fallback')).toBeNull()
  })

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

  it('opens the running row with the host receipt time and pins the row time to it', async () => {
    const journal = await journals.open({
      identity: {
        sessionId: SESSION_ID,
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'codex',
        providerHandle: codexProviderHandle(THREAD_ID)
      },
      now: () => 9_000,
      stateDirectory: join(fixture.root, SESSION_ID)
    })
    const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
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
      expect.objectContaining({ kind: 'outcome', seq: before.sequence + 1 })
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
})
