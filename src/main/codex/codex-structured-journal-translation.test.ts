import { describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type { JournalLifecycleMutationInput } from '../native-chat/agent-session-journal/journal-row-builders'
import { projectStructuredAgentSessionStatus } from '../../shared/structured-agent-session-projection'
import {
  createDeferredStructuredAgentSessionEventSink,
  type StructuredAgentSessionEventSink,
  type StructuredAgentSessionEventTarget
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import { MAX_CODEX_ACTIVE_TURNS } from './codex-structured-journal-translation-turn-state'
import {
  CODEX_COMMAND_APPROVAL_METHOD,
  CODEX_USER_INPUT_METHOD
} from './codex-structured-prompt-replies'
import type { CodexStructuredSessionEvent } from './codex-structured-session-adapter'

const SESSION_ID = 'session-1'
const THREAD_ID = 'thread-abc'
const TURN_ID = 'turn-1'

type Row = { key: string; body: AgentJournalItemBody }

function recorder() {
  const rows: Row[] = []
  const tombstones: string[] = []
  const bound: [string, string, string][] = []
  let publishes = 0
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (identity: AgentJournalItemIdentity, body) =>
      rows.push({ key: agentJournalItemKey(identity), body }),
    appendTombstone: (identity) => tombstones.push(agentJournalItemKey(identity)),
    publish: () => {
      publishes += 1
    }
  }
  return {
    sink,
    rows,
    tombstones,
    bound,
    publishes: () => publishes,
    bindPromptItemId: (journalItemId: string, threadId: string, promptKey: string) =>
      bound.push([journalItemId, threadId, promptKey])
  }
}

/** Fires the coalescing window on demand instead of on wall time. */
function manualWindow() {
  const pending: (() => void)[] = []
  return {
    schedule: (run: () => void) => {
      pending.push(run)
      return () => {
        const index = pending.indexOf(run)
        if (index !== -1) {
          pending.splice(index, 1)
        }
      }
    },
    fire: () => {
      const due = pending.splice(0)
      for (const run of due) {
        run()
      }
    },
    idle: () => pending.length === 0
  }
}

function notification(method: string, params: unknown): CodexStructuredSessionEvent {
  return { type: 'notification', sessionId: SESSION_ID, threadId: THREAD_ID, method, params }
}

const TURN_STARTED = notification('turn/started', { turn: { id: TURN_ID } })

function translatorWith(tap = recorder(), window = manualWindow()) {
  const translator = createCodexJournalTranslator({
    sink: tap.sink,
    bindPromptItemId: tap.bindPromptItemId,
    schedule: window.schedule
  })
  return { translator, tap, window }
}

function deferredTarget(
  log: AgentJournalItemBody[],
  publishes: string[] = []
): StructuredAgentSessionEventTarget {
  return {
    fence: 7,
    journal: {
      appendItem: vi.fn(async (_identity: AgentJournalItemIdentity, body: AgentJournalItemBody) => {
        log.push(body)
        return { cursor: { epoch: 'e', sequence: log.length } }
      }),
      appendTombstone: vi.fn(async () => ({ epoch: 'e', sequence: log.length })),
      appendLifecycleBatch: vi.fn(
        async (input: { mutations: readonly JournalLifecycleMutationInput[] }) => {
          for (const mutation of input.mutations) {
            if (mutation.kind === 'item') {
              log.push(mutation.body)
            }
          }
          return { epoch: 'e', sequence: log.length }
        }
      )
    } as unknown as StructuredAgentSessionEventTarget['journal'],
    publish: vi.fn(() => {
      publishes.push('publish')
    })
  }
}

function hardWatermarkDeferred() {
  return createDeferredStructuredAgentSessionEventSink({
    watermarks: {
      pauseQueuedBytes: 1,
      maxQueuedBytes: 1,
      lowQueuedBytes: 0,
      pauseQueuedOperations: 1,
      maxQueuedOperations: 0,
      lowQueuedOperations: 0
    }
  })
}

describe('codex journal translation', () => {
  it('refuses an active-turn overflow before publishing an un-settleable lifecycle row', () => {
    const tap = recorder()
    const translator = createCodexJournalTranslator({
      sink: tap.sink,
      primaryThreadId: () => THREAD_ID
    })

    for (let index = 0; index < MAX_CODEX_ACTIVE_TURNS; index += 1) {
      expect(
        translator.handle(notification('turn/started', { turn: { id: `turn-${index}` } }))
      ).toEqual({ accepted: true })
    }
    expect(
      translator.handle(notification('turn/started', { turn: { id: 'turn-overflow' } }))
    ).toEqual({ accepted: false, reason: 'backpressure' })
    expect(tap.rows.filter((row) => row.body.kind === 'status')).toHaveLength(
      MAX_CODEX_ACTIVE_TURNS
    )

    expect(translator.handle(notification('turn/completed', { turn: { id: 'turn-0' } }))).toEqual({
      accepted: true
    })
    expect(
      translator.handle(notification('turn/started', { turn: { id: 'turn-overflow' } }))
    ).toEqual({ accepted: true })
  })

  it('projects turns restored by thread/resume into durable conversation rows', () => {
    const { translator, tap } = translatorWith()

    translator.restoreThread(THREAD_ID, {
      turns: [
        {
          id: 'turn-restored',
          items: [
            {
              type: 'userMessage',
              id: 'user-restored',
              content: [{ type: 'text', text: 'existing question' }]
            },
            { type: 'agentMessage', id: 'agent-restored', text: 'existing answer' }
          ]
        }
      ]
    })

    expect(tap.rows.map((row) => row.body)).toEqual([
      {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: 'existing question' }]
      },
      {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'existing answer' }]
      }
    ])
  })

  it('refuses an old-provider restore above the operation bound before partial import', () => {
    const { translator, tap } = translatorWith()
    const result = translator.restoreThread(THREAD_ID, {
      turns: [
        {
          id: 'turn-restored',
          items: Array.from({ length: 1_025 }, (_, index) => ({
            type: 'agentMessage',
            id: `agent-${index}`,
            text: `answer-${index}`
          }))
        }
      ]
    })

    expect(result).toEqual({ accepted: false, reason: 'backpressure' })
    expect(tap.rows).toEqual([])
    expect(tap.publishes()).toBe(0)
  })

  it('durably opens and closes the primary turn cancellation lifecycle', () => {
    const tap = recorder()
    const translator = createCodexJournalTranslator({
      sink: tap.sink,
      primaryThreadId: () => THREAD_ID
    })

    translator.handle(TURN_STARTED)
    translator.handle(notification('turn/completed', { turn: { id: TURN_ID } }))

    expect(tap.rows).toEqual([
      {
        key: 'legacy:codex:session-1:turn-lifecycle%3Aturn-1',
        body: {
          kind: 'status',
          text: 'Codex is working…',
          turnLifecycle: { turnId: TURN_ID, state: 'running' }
        }
      }
    ])
    expect(tap.tombstones).toEqual(['legacy:codex:session-1:turn-lifecycle%3Aturn-1'])
  })

  it('closes every active turn when the provider session ends after a later turn starts', () => {
    const tap = recorder()
    const translator = createCodexJournalTranslator({
      sink: tap.sink,
      primaryThreadId: () => THREAD_ID
    })

    translator.handle(notification('turn/started', { turn: { id: 'turn-stale' } }))
    translator.handle(notification('turn/started', { turn: { id: 'turn-later' } }))
    translator.handle({ type: 'ended', sessionId: SESSION_ID, reason: 'app-server exited' })

    expect(tap.rows.filter((row) => row.body.kind === 'status')).toHaveLength(3)
    expect(tap.rows.map((row) => row.body)).toEqual([
      expect.objectContaining({ turnLifecycle: { turnId: 'turn-stale', state: 'running' } }),
      expect.objectContaining({ turnLifecycle: { turnId: 'turn-later', state: 'running' } }),
      expect.objectContaining({ text: 'Provider exited: app-server exited' })
    ])
    expect(tap.tombstones).toEqual([
      'legacy:codex:session-1:turn-lifecycle%3Aturn-stale',
      'legacy:codex:session-1:turn-lifecycle%3Aturn-later'
    ])
    // The tombstones remove both running rows from the reduced journal; no
    // lifecycle identity remains live after a session end.
    expect(
      projectStructuredAgentSessionStatus(
        tap.rows
          .filter((row) => !tap.tombstones.includes(row.key))
          .map((row, sequence) => ({
            itemId: row.key,
            revision: 1,
            sequence: sequence + 1,
            observedAt: sequence + 1,
            body: row.body
          }))
      )
    ).toBe('idle')
  })

  it('matches out-of-order completions to each turn identity', () => {
    const tap = recorder()
    const translator = createCodexJournalTranslator({
      sink: tap.sink,
      primaryThreadId: () => THREAD_ID
    })

    translator.handle(notification('turn/started', { turn: { id: 'turn-stale' } }))
    translator.handle(notification('turn/started', { turn: { id: 'turn-later' } }))
    translator.handle(notification('turn/completed', { turn: { id: 'turn-stale' } }))
    translator.handle(notification('turn/completed', { turn: { id: 'turn-later' } }))

    expect(tap.tombstones).toEqual([
      'legacy:codex:session-1:turn-lifecycle%3Aturn-stale',
      'legacy:codex:session-1:turn-lifecycle%3Aturn-later'
    ])
    expect(
      projectStructuredAgentSessionStatus(
        tap.rows
          .filter((row) => !tap.tombstones.includes(row.key))
          .map((row, sequence) => ({
            itemId: row.key,
            revision: 1,
            sequence: sequence + 1,
            observedAt: sequence + 1,
            body: row.body
          }))
      )
    ).toBe('idle')
  })

  it('journals a user turn and the assistant answer under durable codex keys', () => {
    const { translator, tap } = translatorWith()

    translator.handle(TURN_STARTED)
    translator.handle(
      notification('item/completed', {
        item: { type: 'userMessage', id: 'item-0', content: [{ type: 'text', text: 'hi' }] }
      })
    )
    translator.handle(
      notification('item/completed', {
        item: { type: 'agentMessage', id: 'item-1', text: 'hello' }
      })
    )

    expect(tap.rows.map((row) => row.key)).toEqual([
      'codex:thread-abc:turn-1:0',
      'codex:thread-abc:turn-1:1'
    ])
    expect(tap.rows[1]?.body).toEqual({
      kind: 'message',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'hello' }]
    })
  })

  it('folds streamed deltas into one snapshot row on the same key the item started under', () => {
    const { translator, tap, window } = translatorWith()

    translator.handle(TURN_STARTED)
    translator.handle(
      notification('item/started', { item: { type: 'agentMessage', id: 'item-1', text: '' } })
    )
    translator.handle(notification('item/agentMessage/delta', { itemId: 'item-1', delta: 'he' }))
    translator.handle(notification('item/agentMessage/delta', { itemId: 'item-1', delta: 'llo' }))
    window.fire()

    // `item/started` had no text to journal; only the coalesced snapshot lands.
    expect(tap.rows).toEqual([
      {
        key: 'codex:thread-abc:turn-1:0',
        body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'hello' }] }
      }
    ])
  })

  it('upserts the streamed text and the completed body onto one row, body last', () => {
    const { translator, tap, window } = translatorWith()

    translator.handle(TURN_STARTED)
    translator.handle(
      notification('item/started', { item: { type: 'agentMessage', id: 'item-1', text: '' } })
    )
    translator.handle(notification('item/agentMessage/delta', { itemId: 'item-1', delta: 'part' }))
    translator.handle(
      notification('item/completed', {
        item: { type: 'agentMessage', id: 'item-1', text: 'partial' }
      })
    )
    window.fire()

    // One key, so the reducer keeps the last write; the stale snapshot cannot
    // come back after the window it was pending on fires.
    expect(new Set(tap.rows.map((row) => row.key))).toEqual(new Set(['codex:thread-abc:turn-1:0']))
    expect(tap.rows.map((row) => row.body)).toEqual([
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'part' }] },
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'partial' }] }
    ])
  })

  it('flushes pending text before a lifecycle event, so nothing is journaled ahead of it', () => {
    const { translator, tap } = translatorWith()

    translator.handle(TURN_STARTED)
    translator.handle(
      notification('item/started', { item: { type: 'agentMessage', id: 'item-1', text: '' } })
    )
    translator.handle(notification('item/agentMessage/delta', { itemId: 'item-1', delta: 'text' }))
    translator.handle(
      notification('item/started', {
        item: { type: 'commandExecution', id: 'item-2', command: 'ls', status: 'inProgress' }
      })
    )

    expect(tap.rows.map((row) => row.key)).toEqual([
      'codex:thread-abc:turn-1:0',
      'orca:codex-item%3Athread-abc%3Aitem-2'
    ])
  })

  it('flushes what streamed when the child dies unannounced', () => {
    const { translator, tap, window } = translatorWith()

    translator.handle(TURN_STARTED)
    translator.handle(
      notification('item/started', { item: { type: 'agentMessage', id: 'item-1', text: '' } })
    )
    translator.handle(notification('item/agentMessage/delta', { itemId: 'item-1', delta: 'half' }))
    translator.handle({ type: 'ended', sessionId: SESSION_ID, reason: 'app-server exited' })

    expect(tap.rows.map((row) => row.body)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ blocks: [{ type: 'text', text: 'half' }] }),
        { kind: 'status', text: 'Provider exited: app-server exited' }
      ])
    )
    expect(window.idle()).toBe(true)
  })

  it('settles tools, prompts, exit status, and turn tombstone in one ordered batch', () => {
    const tap = recorder()
    const batches: { settlementId: string; mutations: unknown[] }[] = []
    tap.sink.appendLifecycleBatch = (settlementId, mutations) => {
      batches.push({ settlementId, mutations: [...mutations] })
    }
    const translator = createCodexJournalTranslator({
      sink: tap.sink,
      bindPromptItemId: tap.bindPromptItemId,
      primaryThreadId: () => THREAD_ID
    })
    translator.handle(TURN_STARTED)
    translator.handle(
      notification('item/started', {
        item: { type: 'commandExecution', id: 'exec-1', command: 'run', status: 'inProgress' }
      })
    )
    translator.handle(
      notification('item/commandExecution/outputDelta', { itemId: 'exec-1', delta: 'partial' })
    )
    translator.handle({
      type: 'prompt',
      sessionId: SESSION_ID,
      threadId: THREAD_ID,
      method: CODEX_COMMAND_APPROVAL_METHOD,
      params: {},
      codexItemId: 'exec-1',
      promptKey: 'approval-1'
    })

    translator.handle({
      type: 'ended',
      sessionId: SESSION_ID,
      reason: 'lost child',
      cause: 'unexpected-exit',
      fence: 7,
      acquisitionGeneration: 'generation-1'
    })

    expect(batches).toHaveLength(1)
    expect(batches[0]?.settlementId).toBe('provider-exit:session-1:7:generation-1')
    expect(batches[0]?.mutations).toEqual([
      expect.objectContaining({
        kind: 'item',
        body: expect.objectContaining({ kind: 'tool-call', state: 'failed' })
      }),
      expect.objectContaining({
        kind: 'item',
        body: expect.objectContaining({
          kind: 'approval',
          resolution: expect.objectContaining({ state: 'cancelled' })
        })
      }),
      expect.objectContaining({
        kind: 'item',
        body: { kind: 'status', text: 'Provider exited: lost child' }
      }),
      expect.objectContaining({ kind: 'tombstone' })
    ])
  })

  it('admits authoritative item completion across the deferred sink hard watermark', async () => {
    const bodies: AgentJournalItemBody[] = []
    const publishes: string[] = []
    const readingControl = { pauseReading: vi.fn(), resumeReading: vi.fn() }
    const deferred = createDeferredStructuredAgentSessionEventSink({
      watermarks: {
        pauseQueuedBytes: 1,
        maxQueuedBytes: 1,
        lowQueuedBytes: 0,
        pauseQueuedOperations: 1,
        maxQueuedOperations: 0,
        lowQueuedOperations: 0
      },
      readingControl
    })
    const translator = createCodexJournalTranslator({ sink: deferred.sink })

    translator.handle(
      notification('item/started', {
        item: { type: 'commandExecution', id: 'exec-hard-watermark', status: 'inProgress' }
      })
    )
    translator.handle(
      notification('item/completed', {
        item: {
          type: 'commandExecution',
          id: 'exec-hard-watermark',
          command: 'run',
          status: 'completed',
          aggregated_output: 'done'
        }
      })
    )

    expect(deferred.state()).toMatchObject({ queuedOperations: 3, backpressured: true })
    expect(readingControl.pauseReading).toHaveBeenCalled()

    deferred.bind(deferredTarget(bodies, publishes))
    await expect(deferred.lifecycleBarrier()).resolves.toEqual({ ok: true })

    expect(bodies).toEqual([
      expect.objectContaining({ kind: 'tool-call', state: 'running' }),
      expect.objectContaining({
        kind: 'tool-call',
        state: 'completed',
        output: expect.objectContaining({ head: 'done' })
      })
    ])
    expect(publishes).toHaveLength(1)
    expect(deferred.state()).toMatchObject({ queuedOperations: 0, backpressured: false })
    expect(readingControl.resumeReading).toHaveBeenCalled()

    translator.handle(
      notification('item/completed', {
        item: { type: 'agentMessage', id: 'next-message', text: 'next turn still works' }
      })
    )
    await expect(deferred.lifecycleBarrier()).resolves.toEqual({ ok: true })
    expect(bodies.at(-1)).toMatchObject({
      kind: 'message',
      blocks: [{ type: 'text', text: 'next turn still works' }]
    })
  })

  it('admits command approval prompts and their publish across the hard watermark', async () => {
    const bodies: AgentJournalItemBody[] = []
    const publishes: string[] = []
    const bound: [string, string, string][] = []
    const deferred = hardWatermarkDeferred()
    const translator = createCodexJournalTranslator({
      sink: deferred.sink,
      bindPromptItemId: (journalItemId, threadId, promptKey) =>
        bound.push([journalItemId, threadId, promptKey])
    })

    const admission = translator.handle({
      type: 'prompt',
      sessionId: SESSION_ID,
      threadId: THREAD_ID,
      method: CODEX_COMMAND_APPROVAL_METHOD,
      params: { availableDecisions: ['accept', 'decline'] },
      codexItemId: 'exec-1',
      promptKey: 'approval-hard-watermark'
    })

    expect(admission).toEqual({ accepted: true })
    expect(bound).toEqual([
      [
        'orca:codex-prompt%3Athread-abc%3Aapproval-hard-watermark',
        THREAD_ID,
        'approval-hard-watermark'
      ]
    ])
    expect(deferred.state()).toMatchObject({ queuedOperations: 2, backpressured: true })

    deferred.bind(deferredTarget(bodies, publishes))
    await expect(deferred.lifecycleBarrier()).resolves.toEqual({ ok: true })

    expect(bodies).toEqual([
      expect.objectContaining({
        kind: 'approval',
        resolution: expect.objectContaining({ state: 'pending' })
      })
    ])
    expect(publishes).toHaveLength(1)
  })

  it('admits user-input prompt questions and their publish across the hard watermark', async () => {
    const bodies: AgentJournalItemBody[] = []
    const publishes: string[] = []
    const bound: [string, string, string][] = []
    const deferred = hardWatermarkDeferred()
    const translator = createCodexJournalTranslator({
      sink: deferred.sink,
      bindPromptItemId: (journalItemId, threadId, promptKey) =>
        bound.push([journalItemId, threadId, promptKey])
    })

    const admission = translator.handle({
      type: 'prompt',
      sessionId: SESSION_ID,
      threadId: THREAD_ID,
      method: CODEX_USER_INPUT_METHOD,
      params: {
        questions: [
          { id: 'q1', question: 'Which branch?', options: [{ label: 'main' }] },
          { id: 'q2', question: 'Proceed?', options: [{ label: 'yes' }] }
        ]
      },
      codexItemId: 'exec-1',
      promptKey: 'input-hard-watermark'
    })

    expect(admission).toEqual({ accepted: true })
    expect(bound.map(([journalItemId]) => journalItemId)).toEqual([
      'orca:codex-prompt%3Athread-abc%3Ainput-hard-watermark%3Aq1',
      'orca:codex-prompt%3Athread-abc%3Ainput-hard-watermark%3Aq2'
    ])
    expect(deferred.state()).toMatchObject({ queuedOperations: 2, backpressured: true })

    deferred.bind(deferredTarget(bodies, publishes))
    await expect(deferred.lifecycleBarrier()).resolves.toEqual({ ok: true })

    expect(bodies).toEqual([
      expect.objectContaining({ kind: 'question', question: 'Which branch?' }),
      expect.objectContaining({ kind: 'question', question: 'Proceed?' })
    ])
    expect(publishes).toHaveLength(1)
  })

  it('refuses an untranslated user-input prompt without binding live state', () => {
    const tap = recorder()
    const translator = createCodexJournalTranslator({
      sink: tap.sink,
      bindPromptItemId: tap.bindPromptItemId
    })

    const admission = translator.handle({
      type: 'prompt',
      sessionId: SESSION_ID,
      threadId: THREAD_ID,
      method: CODEX_USER_INPUT_METHOD,
      params: { questions: [{ id: 'q1' }] },
      codexItemId: 'exec-1',
      promptKey: 'untranslated-input'
    })

    expect(admission).toEqual({ accepted: false, reason: 'untranslated' })
    expect(tap.rows).toEqual([])
    expect(tap.bound).toEqual([])
    expect(tap.publishes()).toBe(0)
  })

  it('admits turn start publication across the hard watermark', async () => {
    const bodies: AgentJournalItemBody[] = []
    const publishes: string[] = []
    const deferred = hardWatermarkDeferred()
    const translator = createCodexJournalTranslator({
      sink: deferred.sink,
      primaryThreadId: () => THREAD_ID
    })

    expect(translator.handle(TURN_STARTED)).toEqual({ accepted: true })
    expect(deferred.state()).toMatchObject({ queuedOperations: 2, backpressured: true })

    deferred.bind(deferredTarget(bodies, publishes))
    await expect(deferred.lifecycleBarrier()).resolves.toEqual({ ok: true })

    expect(bodies).toEqual([
      expect.objectContaining({
        kind: 'status',
        turnLifecycle: { turnId: TURN_ID, state: 'running' }
      })
    ])
    expect(publishes).toHaveLength(1)
  })
})
