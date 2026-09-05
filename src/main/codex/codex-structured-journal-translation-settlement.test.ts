import { describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { createJournalReducerState } from '../native-chat/agent-session-journal/journal-reducer'
import {
  journalLifecycleBatchRowBuilder,
  type JournalLifecycleMutationInput
} from '../native-chat/agent-session-journal/journal-row-builders'
import {
  journalRowByteLength,
  MAX_JOURNAL_LIFECYCLE_BATCH_BYTES,
  MAX_JOURNAL_LIFECYCLE_BATCH_MUTATIONS
} from '../native-chat/agent-session-journal/journal-row-schema'
import {
  createDeferredStructuredAgentSessionEventSink,
  type StructuredAgentSessionEventSink,
  type StructuredAgentSessionEventTarget
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import {
  CODEX_COMMAND_APPROVAL_METHOD,
  CODEX_USER_INPUT_METHOD
} from './codex-structured-prompt-replies'
import type { CodexStructuredSessionEvent } from './codex-structured-session-adapter'

const SESSION_ID = 'session-1'
const THREAD_ID = 'thread-abc'
const TURN_ID = 'turn-1'

type Row = { key: string; body: AgentJournalItemBody }
type LifecycleBatch = {
  settlementId: string
  mutations: JournalLifecycleMutationInput[]
}

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

function terminalExitBatches(count: number, outputBytes: number): LifecycleBatch[] {
  const tap = recorder()
  const batches: LifecycleBatch[] = []
  tap.sink.appendLifecycleBatch = (settlementId, mutations) => {
    batches.push({ settlementId, mutations: [...mutations] })
  }
  const translator = createCodexJournalTranslator({
    sink: tap.sink,
    primaryThreadId: () => THREAD_ID
  })
  const output = 'x'.repeat(outputBytes)
  translator.handle(TURN_STARTED)
  for (let index = 0; index < count; index += 1) {
    const itemId = `exec-${index}`
    translator.handle(
      notification('item/started', {
        item: {
          type: 'commandExecution',
          id: itemId,
          command: `run-${index}`,
          status: 'inProgress'
        }
      })
    )
    translator.handle(notification('item/commandExecution/outputDelta', { itemId, delta: output }))
  }
  translator.handle({
    type: 'ended',
    sessionId: SESSION_ID,
    reason: 'lost child',
    cause: 'unexpected-exit',
    fence: 7,
    acquisitionGeneration: 'generation-1'
  })
  return batches
}

function expectLifecycleBatchBounds(batches: readonly LifecycleBatch[]): void {
  for (const [index, batch] of batches.entries()) {
    expect(batch.mutations.length).toBeLessThanOrEqual(MAX_JOURNAL_LIFECYCLE_BATCH_MUTATIONS)
    const state = createJournalReducerState(SESSION_ID, 'epoch-test')
    const row = journalLifecycleBatchRowBuilder(() => state, batch.settlementId, batch.mutations, {
      fence: 7
    })(index + 1, index + 1)
    expect(journalRowByteLength(row)).toBeLessThanOrEqual(MAX_JOURNAL_LIFECYCLE_BATCH_BYTES)
  }
}

describe('codex journal translation', () => {
  it('admits turn start and turn settlement publications across the hard watermark', async () => {
    const bodies: AgentJournalItemBody[] = []
    const publishes: string[] = []
    const deferred = hardWatermarkDeferred()
    const translator = createCodexJournalTranslator({
      sink: deferred.sink,
      primaryThreadId: () => THREAD_ID
    })

    expect(translator.handle(TURN_STARTED)).toEqual({ accepted: true })
    translator.handle(
      notification('item/started', {
        item: {
          type: 'commandExecution',
          id: 'exec-hard-settlement',
          command: 'run',
          status: 'inProgress'
        }
      })
    )
    expect(translator.handle(notification('turn/completed', { turn: { id: TURN_ID } }))).toEqual({
      accepted: true
    })
    expect(deferred.state()).toMatchObject({ queuedOperations: 4, backpressured: true })

    deferred.bind(deferredTarget(bodies, publishes))
    await expect(deferred.lifecycleBarrier()).resolves.toEqual({ ok: true })

    expect(bodies).toEqual([
      expect.objectContaining({
        kind: 'status',
        turnLifecycle: { turnId: TURN_ID, state: 'running' }
      }),
      expect.objectContaining({ kind: 'tool-call', state: 'running' }),
      expect.objectContaining({ kind: 'tool-call', state: 'failed' })
    ])
    expect(publishes).toHaveLength(1)
  })

  it('admits terminal session settlement publication across the hard watermark', async () => {
    const bodies: AgentJournalItemBody[] = []
    const publishes: string[] = []
    const deferred = hardWatermarkDeferred()
    const translator = createCodexJournalTranslator({
      sink: deferred.sink,
      primaryThreadId: () => THREAD_ID
    })

    translator.handle(TURN_STARTED)
    translator.handle({
      type: 'prompt',
      sessionId: SESSION_ID,
      threadId: THREAD_ID,
      method: CODEX_COMMAND_APPROVAL_METHOD,
      params: { availableDecisions: ['accept', 'decline'] },
      codexItemId: 'exec-1',
      promptKey: 'approval-before-exit'
    })
    expect(
      translator.handle({
        type: 'ended',
        sessionId: SESSION_ID,
        reason: 'lost child',
        cause: 'unexpected-exit',
        fence: 7,
        acquisitionGeneration: 'generation-1'
      })
    ).toEqual({ accepted: true })
    expect(deferred.state()).toMatchObject({ queuedOperations: 4, backpressured: true })

    deferred.bind(deferredTarget(bodies, publishes))
    await expect(deferred.lifecycleBarrier()).resolves.toEqual({ ok: true })

    expect(bodies).toEqual([
      expect.objectContaining({
        kind: 'status',
        turnLifecycle: { turnId: TURN_ID, state: 'running' }
      }),
      expect.objectContaining({
        kind: 'approval',
        resolution: expect.objectContaining({ state: 'pending' })
      }),
      expect.objectContaining({
        kind: 'approval',
        resolution: expect.objectContaining({ state: 'cancelled' })
      }),
      { kind: 'status', text: 'Provider exited: lost child' }
    ])
    expect(publishes).toHaveLength(1)
  })

  it('retries a rejected terminal admission without losing tool, prompt, turn, or session truth', () => {
    const batches: LifecycleBatch[] = []
    let rejected = false
    const sink: StructuredAgentSessionEventSink = {
      appendItem: vi.fn(),
      appendTombstone: vi.fn(),
      publish: vi.fn(),
      tryAppendLifecycleBatch: (settlementId, mutations) => {
        if (settlementId.startsWith('provider-exit:') && !rejected) {
          rejected = true
          return { accepted: false, reason: 'backpressure' as const }
        }
        batches.push({ settlementId, mutations: [...mutations] })
        return { accepted: true }
      },
      tryPublish: () => ({ accepted: true })
    }
    const translator = createCodexJournalTranslator({
      sink,
      primaryThreadId: () => THREAD_ID
    })

    translator.handle(TURN_STARTED)
    translator.handle(
      notification('item/started', {
        item: {
          type: 'commandExecution',
          id: 'exec-retry-settlement',
          command: 'run',
          status: 'inProgress'
        }
      })
    )
    translator.handle({
      type: 'prompt',
      sessionId: SESSION_ID,
      threadId: THREAD_ID,
      method: CODEX_COMMAND_APPROVAL_METHOD,
      params: { availableDecisions: ['accept', 'decline'] },
      codexItemId: 'exec-retry-settlement',
      promptKey: 'approval-retry-settlement'
    })
    const ended = {
      type: 'ended' as const,
      sessionId: SESSION_ID,
      reason: 'lost child',
      cause: 'unexpected-exit' as const,
      fence: 7,
      acquisitionGeneration: 'generation-retry'
    }

    expect(translator.handle(ended)).toEqual({ accepted: false, reason: 'backpressure' })
    expect(translator.handle(ended)).toEqual({ accepted: true })

    const mutations = batches.at(-1)?.mutations ?? []
    expect(mutations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          body: expect.objectContaining({ kind: 'tool-call', state: 'failed' })
        }),
        expect.objectContaining({
          body: expect.objectContaining({
            kind: 'approval',
            resolution: expect.objectContaining({ state: 'cancelled' })
          })
        }),
        expect.objectContaining({
          body: { kind: 'status', text: 'Provider exited: lost child' }
        }),
        expect.objectContaining({ kind: 'tombstone' })
      ])
    )
  })

  it('bounds prompt cancellation and exit bodies before lifecycle batching', () => {
    const tap = recorder()
    const batches: LifecycleBatch[] = []
    tap.sink.appendLifecycleBatch = (settlementId, mutations) => {
      batches.push({ settlementId, mutations: [...mutations] })
    }
    const translator = createCodexJournalTranslator({
      sink: tap.sink,
      primaryThreadId: () => THREAD_ID
    })
    const huge = 'x'.repeat(MAX_JOURNAL_LIFECYCLE_BATCH_BYTES + 1_024)

    translator.handle(TURN_STARTED)
    translator.handle({
      type: 'prompt',
      sessionId: SESSION_ID,
      threadId: THREAD_ID,
      method: CODEX_COMMAND_APPROVAL_METHOD,
      params: { command: huge, availableDecisions: ['accept', 'decline'] },
      codexItemId: 'exec-1',
      promptKey: `approval-${huge}`
    })
    translator.handle({
      type: 'prompt',
      sessionId: SESSION_ID,
      threadId: THREAD_ID,
      method: CODEX_USER_INPUT_METHOD,
      params: {
        questions: [
          {
            id: `question-${huge}`,
            question: huge,
            options: [{ label: huge }, { label: `${huge}b` }]
          }
        ]
      },
      codexItemId: 'exec-1',
      promptKey: `question-${huge}`
    })
    translator.handle({
      type: 'ended',
      sessionId: SESSION_ID,
      reason: huge,
      cause: 'unexpected-exit',
      fence: 7,
      acquisitionGeneration: 'generation-1'
    })

    expectLifecycleBatchBounds(batches)
    expect(JSON.stringify(batches)).toContain('output truncated')
  })

  it('splits many large terminal items before the lifecycle row byte boundary', () => {
    const batches = terminalExitBatches(120, 20_000)
    const flattened = batches.flatMap((batch) => batch.mutations)

    expect(batches.length).toBeGreaterThan(1)
    expect(batches.map((batch) => batch.settlementId)).toEqual(
      batches.map(
        (_batch, index) =>
          `provider-exit:${SESSION_ID}:7:generation-1:${index + 1}/${batches.length}`
      )
    )
    expect(flattened).toHaveLength(122)
    expect(flattened.at(-2)).toMatchObject({
      kind: 'item',
      body: { kind: 'status', text: 'Provider exited: lost child' }
    })
    expect(flattened.at(-1)).toMatchObject({ kind: 'tombstone' })
    expectLifecycleBatchBounds(batches)
  })

  it('partitions large terminal settlements by both byte and mutation bounds', () => {
    const batches = terminalExitBatches(240, 20_000)
    const mutationOnlyChunkCount = Math.ceil(
      batches.flatMap((batch) => batch.mutations).length / MAX_JOURNAL_LIFECYCLE_BATCH_MUTATIONS
    )

    expect(batches.length).toBeGreaterThan(mutationOnlyChunkCount)
    expectLifecycleBatchBounds(batches)
  })

  it('bounds one streamed assistant settlement before lifecycle batching', () => {
    const tap = recorder()
    const batches: LifecycleBatch[] = []
    tap.sink.appendLifecycleBatch = (settlementId, mutations) => {
      batches.push({ settlementId, mutations: [...mutations] })
    }
    const translator = createCodexJournalTranslator({
      sink: tap.sink,
      primaryThreadId: () => THREAD_ID,
      maxRetainedBytes: MAX_JOURNAL_LIFECYCLE_BATCH_BYTES + 1_024
    })
    const oversized = 'a'.repeat(MAX_JOURNAL_LIFECYCLE_BATCH_BYTES + 1_024)

    translator.handle(TURN_STARTED)
    translator.handle(
      notification('item/started', { item: { type: 'agentMessage', id: 'assistant-1', text: '' } })
    )
    translator.handle(
      notification('item/agentMessage/delta', { itemId: 'assistant-1', delta: oversized })
    )
    translator.handle({
      type: 'ended',
      sessionId: SESSION_ID,
      reason: 'lost child',
      cause: 'unexpected-exit',
      fence: 7,
      acquisitionGeneration: 'generation-1'
    })

    const checkpoint = tap.rows.find((row) => row.body.kind === 'message')?.body
    const settled = batches
      .flatMap((batch) => batch.mutations)
      .find((mutation) => mutation.kind === 'item' && mutation.body.kind === 'message') as
      | Extract<JournalLifecycleMutationInput, { kind: 'item' }>
      | undefined
    const checkpointText =
      checkpoint?.kind === 'message' && checkpoint.blocks[0]?.type === 'text'
        ? checkpoint.blocks[0].text
        : ''
    const settledText =
      settled?.body.kind === 'message' && settled.body.blocks[0]?.type === 'text'
        ? settled.body.blocks[0].text
        : ''

    expect(checkpointText).toContain('output truncated')
    expect(settledText).toContain('output truncated')
    expect(Buffer.byteLength(settledText, 'utf8')).toBeLessThan(20 * 1024)
    expectLifecycleBatchBounds(batches)
  })

  it('bounds authoritative completed assistant text before the journal append', () => {
    const { translator, tap } = translatorWith()
    const oversized = 'b'.repeat(MAX_JOURNAL_LIFECYCLE_BATCH_BYTES + 1_024)

    translator.handle(TURN_STARTED)
    translator.handle(
      notification('item/completed', {
        item: { type: 'agentMessage', id: 'assistant-1', text: oversized }
      })
    )

    const body = tap.rows[0]?.body
    const text =
      body?.kind === 'message' && body.blocks[0]?.type === 'text' ? body.blocks[0].text : ''
    expect(text).toContain('output truncated')
    expect(Buffer.byteLength(JSON.stringify(body), 'utf8')).toBeLessThan(20 * 1024)
  })

  it('terminalizes an active tool when its turn completes', () => {
    const tap = recorder()
    const batches: { settlementId: string; mutations: unknown[] }[] = []
    tap.sink.appendLifecycleBatch = (settlementId, mutations) => {
      batches.push({ settlementId, mutations: [...mutations] })
    }
    const translator = createCodexJournalTranslator({
      sink: tap.sink,
      primaryThreadId: () => THREAD_ID
    })

    translator.handle(TURN_STARTED)
    translator.handle(
      notification('item/started', {
        item: { type: 'commandExecution', id: 'exec-active', command: 'run', status: 'inProgress' }
      })
    )
    translator.handle(
      notification('item/commandExecution/outputDelta', {
        itemId: 'exec-active',
        delta: 'partial'
      })
    )
    translator.handle(notification('turn/completed', { turn: { id: TURN_ID } }))

    expect(batches).toEqual([
      {
        settlementId: `turn-completed:${SESSION_ID}:${THREAD_ID}:${TURN_ID}`,
        mutations: [
          expect.objectContaining({
            kind: 'item',
            identity: expect.objectContaining({ provider: 'orca' }),
            body: expect.objectContaining({
              kind: 'tool-call',
              state: 'failed',
              output: expect.objectContaining({ head: 'partial' })
            })
          }),
          expect.objectContaining({
            kind: 'tombstone',
            identity: {
              provider: 'legacy',
              agent: 'codex',
              sessionId: SESSION_ID,
              recordId: `turn-lifecycle:${TURN_ID}`
            }
          })
        ]
      }
    ])
  })

  it('journals an approval naming the command the item already announced, and binds it', () => {
    const { translator, tap } = translatorWith()

    translator.handle(TURN_STARTED)
    translator.handle(
      notification('item/started', {
        item: {
          type: 'commandExecution',
          id: 'item-2',
          command: 'rm -rf build',
          status: 'inProgress'
        }
      })
    )
    translator.handle({
      type: 'prompt',
      sessionId: SESSION_ID,
      threadId: THREAD_ID,
      method: CODEX_COMMAND_APPROVAL_METHOD,
      params: { availableDecisions: ['accept', 'decline'] },
      codexItemId: 'item-2',
      promptKey: 'item-2'
    })

    const approval = tap.rows.at(-1)
    expect(approval?.key).toBe('orca:codex-prompt%3Athread-abc%3Aitem-2')
    expect(approval?.body).toMatchObject({ kind: 'approval', detail: 'rm -rf build' })
    expect(tap.bound).toEqual([['orca:codex-prompt%3Athread-abc%3Aitem-2', THREAD_ID, 'item-2']])
  })

  it('journals one row per approval when a tool item asks twice', () => {
    const { translator, tap } = translatorWith()
    const ask = (promptKey: string): void => {
      translator.handle({
        type: 'prompt',
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        method: CODEX_COMMAND_APPROVAL_METHOD,
        params: { availableDecisions: ['accept', 'decline'] },
        codexItemId: 'item-2',
        promptKey
      })
    }

    translator.handle(TURN_STARTED)
    translator.handle(
      notification('item/started', {
        item: { type: 'commandExecution', id: 'item-2', command: 'ls', status: 'inProgress' }
      })
    )
    ask('approval-a')
    ask('approval-b')

    // Two asks, two answerable rows — keying by the tool item would have made the
    // second ask overwrite the first, leaving the turn blocked.
    const approvals = tap.rows.slice(-2)
    expect(approvals.map((row) => row.key)).toEqual([
      'orca:codex-prompt%3Athread-abc%3Aapproval-a',
      'orca:codex-prompt%3Athread-abc%3Aapproval-b'
    ])
    // Both still name the command the shared item announced.
    expect(approvals.every((row) => (row.body as { detail?: string }).detail === 'ls')).toBe(true)
    expect(tap.bound.map(([, , promptKey]) => promptKey)).toEqual(['approval-a', 'approval-b'])
  })

  it('journals and binds one row per question in a user-input request', () => {
    const { translator, tap } = translatorWith()

    translator.handle(TURN_STARTED)
    translator.handle({
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
      codexItemId: 'item-3',
      promptKey: 'item-3'
    })

    expect(tap.rows.map((row) => row.key)).toEqual([
      'orca:codex-prompt%3Athread-abc%3Aitem-3%3Aq1',
      'orca:codex-prompt%3Athread-abc%3Aitem-3%3Aq2'
    ])
    expect(tap.bound.map(([, , promptKey]) => promptKey)).toEqual(['item-3', 'item-3'])
  })

  it('starts a new turn at ordinal zero and refuses to adopt an ended turn', () => {
    const { translator, tap } = translatorWith()

    translator.handle(TURN_STARTED)
    translator.handle(
      notification('item/completed', { item: { type: 'userMessage', id: 'item-0', text: 'one' } })
    )
    translator.handle(notification('turn/completed', { turn: { id: TURN_ID } }))
    translator.handle(
      notification('item/completed', {
        item: { type: 'agentMessage', id: 'item-1', text: 'orphan' }
      })
    )
    translator.handle(notification('turn/started', { turn: { id: 'turn-2' } }))
    translator.handle(
      notification('item/completed', { item: { type: 'userMessage', id: 'item-2', text: 'two' } })
    )

    expect(tap.rows.map((row) => row.key)).toEqual([
      'codex:thread-abc:turn-1:0',
      'orca:codex-item%3Athread-abc%3Aitem-1',
      'codex:thread-abc:turn-2:0'
    ])
  })

  it('prefers a turn id the event carries over the turn currently open', () => {
    const { translator, tap } = translatorWith()

    translator.handle(TURN_STARTED)
    translator.handle(
      notification('item/completed', {
        turnId: 'turn-9',
        item: { type: 'userMessage', id: 'item-0', text: 'late' }
      })
    )

    expect(tap.rows[0]?.key).toBe('codex:thread-abc:turn-9:0')
  })

  it('keeps interleaved thread turns, items, and deltas separate', () => {
    const { translator, tap } = translatorWith()
    const child = (method: string, params: unknown): CodexStructuredSessionEvent => ({
      type: 'notification',
      sessionId: SESSION_ID,
      threadId: 'thread-child',
      method,
      params
    })

    translator.handle(TURN_STARTED)
    translator.handle(child('turn/started', { threadId: 'thread-child', turnId: 'turn-child' }))
    translator.handle(
      notification('item/completed', {
        item: { type: 'agentMessage', id: 'item-0', text: 'root' }
      })
    )
    translator.handle(
      child('item/completed', { item: { type: 'agentMessage', id: 'item-0', text: 'child' } })
    )
    translator.handle(child('turn/completed', { turnId: 'turn-child' }))
    translator.handle(
      notification('item/completed', {
        item: { type: 'agentMessage', id: 'item-1', text: 'still root' }
      })
    )

    expect(tap.rows.map((row) => row.key)).toEqual([
      'codex:thread-abc:turn-1:0',
      'codex:thread-child:turn-child:0',
      'codex:thread-abc:turn-1:1'
    ])
  })

  it('checkpoints long streams geometrically and flushes the final snapshot', () => {
    const { translator, tap, window } = translatorWith()
    translator.handle(TURN_STARTED)
    translator.handle(
      notification('item/started', { item: { type: 'agentMessage', id: 'item-1', text: '' } })
    )

    for (let index = 0; index < 512; index += 1) {
      translator.handle(notification('item/agentMessage/delta', { itemId: 'item-1', delta: 'x' }))
      window.fire()
    }
    translator.flush()

    expect(tap.rows.length).toBeLessThan(40)
    expect(tap.rows.at(-1)?.body).toMatchObject({
      blocks: [{ type: 'text', text: 'x'.repeat(512) }]
    })
  })

  it('folds long-running command output into one exec item and zero generic rows', () => {
    const { translator, tap, window } = translatorWith()
    translator.handle(TURN_STARTED)
    translator.handle(
      notification('item/started', {
        item: { type: 'commandExecution', id: 'exec-1', command: 'long-task', status: 'inProgress' }
      })
    )

    for (let index = 0; index < 512; index += 1) {
      translator.handle(
        notification('item/commandExecution/outputDelta', { itemId: 'exec-1', delta: 'x' })
      )
      window.fire()
    }
    translator.flush()

    expect(new Set(tap.rows.map((row) => row.key))).toEqual(
      new Set(['orca:codex-item%3Athread-abc%3Aexec-1'])
    )
    expect(tap.rows.every((row) => row.body.kind === 'tool-call')).toBe(true)
    expect(tap.rows.length).toBeLessThan(40)
    expect(tap.rows.at(-1)?.body).toMatchObject({
      kind: 'tool-call',
      output: { head: 'x'.repeat(512) }
    })
  })

  it('folds reasoning and patch streams into their parent rows', () => {
    const { translator, tap, window } = translatorWith()
    translator.handle(TURN_STARTED)
    translator.handle(notification('item/started', { item: { type: 'reasoning', id: 'r-1' } }))
    translator.handle(
      notification('item/reasoning/summaryTextDelta', { itemId: 'r-1', delta: 'thinking' })
    )
    translator.handle(
      notification('item/started', {
        item: { type: 'fileChange', id: 'patch-1', changes: [], status: 'inProgress' }
      })
    )
    translator.handle(
      notification('item/fileChange/patchUpdated', {
        itemId: 'patch-1',
        changes: [{ path: 'src/app.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@' }]
      })
    )
    window.fire()

    const reduced = new Map(tap.rows.map((row) => [row.key, row.body]))
    expect(reduced.get('orca:codex-item%3Athread-abc%3Ar-1')).toEqual({
      kind: 'status',
      text: 'thinking'
    })
    expect(reduced.get('orca:codex-item%3Athread-abc%3Apatch-1')).toMatchObject({
      kind: 'diff',
      path: 'src/app.ts',
      patch: { head: '@@ -1 +1 @@' }
    })
  })

  it('retains a rejected patch update for a later admission retry', () => {
    const { translator, tap } = translatorWith()
    let rejectPatch = true
    tap.sink.tryAppendItem = (identity, body, blobs) => {
      if (body.kind === 'diff' && rejectPatch) {
        return { accepted: false as const, reason: 'backpressure' as const }
      }
      tap.sink.appendItem(identity, body, blobs)
      return { accepted: true as const }
    }

    translator.handle(
      notification('item/started', {
        item: { type: 'fileChange', id: 'patch-retry', changes: [], status: 'inProgress' }
      })
    )
    const rejected = translator.handle(
      notification('item/fileChange/patchUpdated', {
        itemId: 'patch-retry',
        changes: [{ path: 'src/app.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@' }]
      })
    )
    expect(rejected).toEqual({ accepted: false, reason: 'backpressure' })
    expect(tap.rows.some((row) => row.body.kind === 'diff')).toBe(false)

    rejectPatch = false
    expect(translator.flush()).toBeUndefined()
    expect(tap.rows.some((row) => row.body.kind === 'diff')).toBe(true)
  })
})
