import type * as ItemEstimateModule from '../native-chat/agent-session-wire/structured-agent-session-event-sink-estimate'
import type * as DeltaCoalescerModule from '../native-chat/agent-session-wire/agent-session-delta-coalescer'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { JsonlRpcTimelineLane } from '../jsonl-rpc/timeline-lane'
import { PiRpcTurns } from './rpc-turns'
import { PiRpcMessages } from './rpc-messages'
import { PiRpcContextUsage } from './rpc-context-usage'
import type { AgentSessionJournal } from '../native-chat/agent-session-journal/journal-store'
import type {
  JournalItemRow,
  JournalRow
} from '../native-chat/agent-session-journal/journal-row-schema'
import type { AgentSessionHistoryRequest } from '../../shared/agent-session-wire'
import type { AgentSessionHistoryScope } from '../native-chat/agent-session-wire/agent-session-history-page'
import { readStructuredAgentSessionHistoryResult } from '../native-chat/agent-session-wire/structured-agent-session-history-result'
import { readStructuredJournalPage } from '../runtime/orchestration/structured-worker-journal-page'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from '../../shared/structured-agent-session-reducer'
import { estimateStructuredAgentSessionItemBytes } from '../native-chat/agent-session-wire/structured-agent-session-event-sink-estimate'

import { PiRpcOptionObservations, readPiRpcSessionOptions } from './rpc-options'
import { piRpcStateSchema } from './rpc-protocol'
import { piRpcFailureFact } from './rpc-prompt-delivery'
import { agentSessionFailureSentence } from '../../shared/agent-session-failure-words'
import { piRpcDialogPresentation } from './rpc-extension-dialogs'
import {
  closeProviderTimelineRigs,
  openProviderTimelineRig
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'

// Observe real public materializations and estimates, preserving original values and admission.
const meter = vi.hoisted(() => {
  const state: { visits: number; full: string[]; bodyEstimates: number } = {
    visits: 0,
    full: [],
    bodyEstimates: 0
  }
  return state
})
vi.mock('../native-chat/agent-session-wire/agent-session-delta-coalescer', async (original) => {
  const actual = await original<typeof DeltaCoalescerModule>()
  return {
    ...actual,
    createAgentSessionDeltaCoalescer: (
      deps: Parameters<typeof actual.createAgentSessionDeltaCoalescer>[0]
    ) => {
      const record = (text: string) => {
        meter.full.push(text)
      }
      const coalescer = actual.createAgentSessionDeltaCoalescer({
        ...deps,
        emit: (key, text, snapshot) => {
          record(text)
          return deps.emit(key, text, snapshot)
        }
      })
      return {
        ...coalescer,
        snapshot: (key: string) => {
          const value = coalescer.snapshot(key)
          if (value) {
            record(value.text)
          }
          return value
        },
        dirty: (select?: (key: string) => boolean) => {
          const values = coalescer.dirty((key) => {
            meter.visits++
            return select?.(key) ?? true
          })
          values.forEach((value) => record(value.snapshot.text))
          return values
        }
      }
    }
  }
})
vi.mock(
  '../native-chat/agent-session-wire/structured-agent-session-event-sink-estimate',
  async (original) => {
    const actual = await original<typeof ItemEstimateModule>()
    return {
      ...actual,
      estimateStructuredAgentSessionItemBytes: (
        ...args: Parameters<typeof actual.estimateStructuredAgentSessionItemBytes>
      ) => {
        if (args[1].kind === 'message') {
          meter.bodyEstimates++
        }
        return actual.estimateStructuredAgentSessionItemBytes(...args)
      }
    }
  }
)
const host = vi.hoisted(() => {
  const state: { journal: AgentSessionJournal | null } = { journal: null }
  return state
})
vi.mock('../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => ({
    history: async (request: AgentSessionHistoryRequest, scope?: AgentSessionHistoryScope) =>
      readStructuredAgentSessionHistoryResult({
        journal: host.journal!,
        record: null,
        request,
        scope
      })
  })
}))

async function consumers(journal: AgentSessionJournal) {
  host.journal = journal
  const expected = journal.snapshot().items
  expect(journal.publicRead().snapshot.items).toEqual(expected)
  const history = readStructuredAgentSessionHistoryResult({
    journal,
    record: null,
    request: {
      sessionId: 'session-timeline',
      direction: 'tail',
      limit: 200
    }
  })
  expect(
    reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
      type: 'history-page',
      page: history.page
    }).items
  ).toEqual(expected)
  expect((await readStructuredJournalPage('session-timeline'))?.items).toEqual(expected)
}

const envelope = z.object({ dir: z.enum(['in', 'out']), raw: z.string() })
const record = z.looseObject({ type: z.string() })
function capture(name: string) {
  return readFileSync(join(import.meta.dirname, '__fixtures__', `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const parsed = envelope.parse(JSON.parse(line))
      return { dir: parsed.dir, frame: record.parse(JSON.parse(parsed.raw)) }
    })
}
const disposals: (() => void)[] = []

it('separates resend advice from the captured Pi 1.0.4 missing-key detail', () => {
  const reply = capture('signed-out').find(
    ({ dir, frame }) => dir === 'out' && frame.command === 'prompt' && frame.success === false
  )?.frame
  if (typeof reply?.error !== 'string') {
    throw new Error('The signed-out capture must contain a prompt error')
  }
  expect(reply.error.endsWith('docs/models.md')).toBe(true)
  const fact = piRpcFailureFact(reply.error)
  expect(fact.kind).toBe('notSignedIn')
  expect(fact.detail?.text).toBe(reply.error)
  expect(agentSessionFailureSentence(fact, 'rejection', { agentName: 'Pi' })).toContain(
    `${reply.error}. Then send your message again.`
  )
})

afterEach(async () => {
  disposals.splice(0).forEach((dispose) => dispose())
  await closeProviderTimelineRigs()
  vi.useRealTimers()
})

async function replay(
  name: string,
  oversized: (frame: z.infer<typeof record>) => boolean = () => false
) {
  const frames = capture(name)
  const states = frames.filter(
    ({ dir, frame }) => dir === 'out' && frame.type === 'response' && frame.command === 'get_state'
  )
  const stats = frames.findLast(
    ({ dir, frame }) =>
      dir === 'out' && frame.type === 'response' && frame.command === 'get_session_stats'
  )?.frame.data
  const rig = await openProviderTimelineRig({ agent: 'pi', sessionId: 'session-timeline' })
  const accepted = vi.fn(),
    failed = vi.fn(),
    idle = vi.fn(),
    settled = vi.fn()
  const lane = new JsonlRpcTimelineLane({
    sink: rig.sink,
    sessionId: 'session-timeline',
    agent: 'pi',
    generation: 'gen-pi',
    namespace: 'pi-session',
    pauseReading: vi.fn(),
    resumeReading: vi.fn(),
    onInputAccepted: accepted,
    onFailed: failed
  })
  const turns = new PiRpcTurns({
    lane,
    generation: 'gen-pi',
    send: vi.fn(async () => {}),
    request: vi.fn(async (command: string) =>
      command === 'get_state' ? states.at(-1)?.frame.data : stats
    ),
    settled,
    failed,
    idle
  })
  disposals.push(() => {
    turns.end()
    lane.dispose()
  })
  let sequence = 0
  for (const { dir, frame } of frames) {
    if (dir === 'in' && frame.type === 'prompt') {
      await turns.submit(`send-${++sequence}`, 100, frame)
    }
    if (dir === 'in' && frame.type === 'abort') {
      turns.stop()
    }
    if (dir === 'out' && oversized(frame)) {
      turns.skipped(frame.type, JSON.stringify(frame).slice(0, 256))
    } else if (dir === 'out' && (frame.type !== 'response' || frame.command === 'prompt')) {
      turns.receive(frame)
    }
    if (dir === 'out' && frame.type === 'response' && frame.command === 'get_state') {
      // The idle probe resolved here in the captured run.
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
  await new Promise<void>((resolve) => setImmediate(resolve))
  lane.flush()
  const rows = await rig.rows()
  const turnRows = await rig.turns()
  await consumers(rig.journal)
  const snapshot = structuredClone(rig.journal.snapshot().items)
  lane.dispose()
  const reopened = await rig.reopenJournal()
  expect(reopened.snapshot().items).toEqual(snapshot)
  await consumers(reopened)
  return { rows, turns: turnRows, accepted, failed, idle, settled }
}

function transcript(rows: Awaited<ReturnType<typeof replay>>['rows']): string {
  return rows
    .flatMap((row) =>
      row.body.kind === 'message'
        ? row.body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
        : []
    )
    .join('\n')
}

describe('scrubbed Pi 1.0.4 RPC captures', () => {
  it('keeps captured current reports provisional until the native model listing arrives', async () => {
    const frames = capture('command-only')
    const response = (command: string) =>
      frames.find(({ dir, frame }) => dir === 'out' && frame.command === command)?.frame.data
    const observed = new PiRpcOptionObservations(
      { current: new Map(), writes: new Map() },
      () => true
    )
    const state = piRpcStateSchema.parse(response('get_state'))
    observed.seed(state)
    observed.prepareState(vi.fn())(state)
    expect(observed.read()).toMatchObject({
      models: [],
      modelsKnown: false,
      current: { model: 'openai-codex/gpt-6.1-sol', effort: 'medium' }
    })
    const adopt = observed.prepare()
    expect(
      adopt(await readPiRpcSessionOptions({ request: async (command) => response(command) }))
    ).toBe(true)
    expect(observed.read().modelsKnown).toBeUndefined()
    expect(observed.read().models).toContainEqual(
      expect.objectContaining({
        id: 'openai-codex/gpt-6.1-sol',
        label: 'GPT-6.1 Sol'
      })
    )
  })

  it('records tool output, streamed text, and all three consumed inputs in one settled run', async () => {
    const result = await replay('steer-followup')
    expect(result.failed).not.toHaveBeenCalled()
    expect(result.accepted.mock.calls.map(([id]) => id)).toEqual(['send-1', 'send-2', 'send-3'])
    expect(result.turns).toHaveLength(1)
    expect(result.turns[0]?.outcome).toBe('success')
    expect(
      result.rows.some((row) => row.body.kind === 'tool-call' && row.body.state === 'completed')
    ).toBe(true)
    expect(transcript(result.rows)).toContain('STEER_CONSUMED')
    expect(transcript(result.rows)).toContain('FOLLOWUP_CONSUMED')
  })
  it('keeps the run and consumed inputs when Pi sends records too large to deliver', async () => {
    const result = await replay('steer-followup', (frame) =>
      ['tool_execution_end', 'message_end', 'turn_end', 'agent_end'].includes(frame.type)
    )
    expect(result.failed).not.toHaveBeenCalled()
    expect(result.accepted.mock.calls.map(([id]) => id)).toEqual(['send-1', 'send-2', 'send-3'])
    expect(result.turns.map((turn) => turn.outcome)).toEqual(['success'])
    expect(
      result.rows.filter((row) => row.body.kind === 'status' && row.body.tone === 'warning')
    ).toHaveLength(1)
    expect(result.rows.find((row) => row.body.kind === 'tool-call')?.body).toMatchObject({
      name: 'bash',
      state: 'completed'
    })
    expect(transcript(result.rows)).toContain('FOLLOWUP_CONSUMED')
  })
  it.each(['provider-fetch-error', 'provider-socket-error'])(
    'marks captured %s as failure with the provider diagnostic',
    async (name) => {
      const result = await replay(name)
      expect(result.failed).not.toHaveBeenCalled()
      expect(result.turns[0]?.outcome).toBe('failure')
      expect(
        result.rows.filter(
          (row) => row.body.kind === 'status' && row.body.failure?.kind === 'providerRejected'
        )
      ).toHaveLength(1)
    }
  )
  it('treats the captured abort error as cancellation', async () => {
    const result = await replay('stop-mid-tool')
    expect(result.failed).not.toHaveBeenCalled()
    expect(result.turns[0]?.outcome).toBe('cancellation')
    expect(result.rows.some((row) => row.body.kind === 'status' && row.body.failure)).toBe(false)
  })
  it('settles a handled extension command with no agent events', async () => {
    const result = await replay('command-only')
    expect(result.failed).not.toHaveBeenCalled()
    expect(result.turns[0]?.outcome).toBe('success')
    expect(result.accepted).toHaveBeenCalledWith('send-1')
  })
  it('tracks the run a captured Pi 1.3.0 subagent wake starts on the idle parent', async () => {
    const result = await replay('subagent-wake')
    expect(result.failed).not.toHaveBeenCalled()
    expect(result.accepted.mock.calls.map(([id]) => id)).toEqual(['send-1'])
    expect(result.turns.map((turn) => turn.outcome)).toEqual(['success', 'success'])
    expect(result.idle).toHaveBeenCalledTimes(2)
    expect(transcript(result.rows)).toContain('WAKE_CONSUMED')
  })
  it('preserves empty answers and literal Unicode separators in captured dialogs', () => {
    const dialogs = capture('dialogs').flatMap(({ dir, frame }) =>
      dir === 'out' && frame.type === 'extension_ui_request' ? [frame] : []
    )
    const input = piRpcDialogPresentation(dialogs.find((frame) => frame.method === 'input'))
    const editor = piRpcDialogPresentation(dialogs.find((frame) => frame.method === 'editor'))
    expect(
      input?.reply({
        kind: 'answers',
        answers: [{ questionId: String(input.id), optionIds: [], other: '' }]
      })
    ).toEqual({ value: '' })
    const body = editor?.body
    expect(body?.kind === 'question' && body.freeTextInput?.initialValue).toContain('\n')
    expect(
      editor?.reply({
        kind: 'answers',
        answers: [
          { questionId: String(editor.id), optionIds: [], other: 'first\u2028second\u2029last' }
        ]
      })
    ).toEqual({ value: 'first\u2028second\u2029last' })
  })
})

it('replays captured compaction with its top-level usage and final full answer', async () => {
  const frame = capture('compaction')[83]!.frame
  expect(frame.usage).toMatchObject({ input: 320, output: 9, cacheRead: 0, cacheWrite: 0 })
  expect(frame.assistantMessageEvent).toMatchObject({ delta: 'ED' })
  const result = await replay('compaction')
  expect(result.failed).not.toHaveBeenCalled()
  expect(result.turns.at(-1)?.outcome).toBe('success')
  expect(transcript(result.rows)).toContain('FOLLOWUP_CONSUMED')
})

it('bounds named metadata work at N/10N with fixed content, duration and genuine boundaries', async () => {
  const observations: {
    channel: 'assistant' | 'reasoning'
    n: 10 | 100
    bodySize: 1000 | 10000
    selectionVisits: number
    fullMaterializations: number
    assembledBytes: number
    bodyEstimateCalls: number
    prefinalTextCommits: number
    committedTextInputs: number
    attemptedTransitions: number
    admittedTransitions: number
    committedMetadataInputs: number
    beforeFinal: number
  }[] = []
  for (const channel of ['assistant', 'reasoning'] as const) {
    for (const [n, bodySize] of [
      [10, 1000],
      [100, 1000],
      [10, 10000],
      [100, 10000]
    ] as const) {
      const rig = await openProviderTimelineRig({ agent: 'pi' })
      rig.assembler.dispose()
      const failed = vi.fn()
      const append = vi.fn(rig.sink.tryAppendTransition)
      const sink = { ...rig.sink, tryAppendTransition: append }
      const lane = new JsonlRpcTimelineLane({
        sink,
        sessionId: 'session-timeline',
        agent: 'pi',
        generation: 'perf',
        namespace: 'perf',
        pauseReading: vi.fn(),
        resumeReading: vi.fn(),
        onInputAccepted: vi.fn(),
        onFailed: failed
      })
      disposals.push(() => lane.dispose())
      const messages = new PiRpcMessages('perf', new PiRpcContextUsage())
      const inputs: JournalRow[] = []
      rig.journal.observeCommits((rows) => inputs.push(...(rows ?? [])))
      vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
      meter.visits = 0
      meter.full.length = 0
      meter.bodyEstimates = 0
      lane.apply([{ type: 'turn.open', turn: 'perf', at: 1 }])
      const body = 'P'.repeat(bodySize)
      const feed = (delta: string, index: number) =>
        lane.apply(
          messages.message(
            {
              type: 'message_update',
              // Exercise both supported source locations; these arrivals are synthetic, not captured Pi frequency.
              ...(index % 2
                ? { usage: { input: index + 1, output: 1, cacheRead: 0, cacheWrite: 0 } }
                : {}),
              assistantMessageEvent: {
                type: channel === 'assistant' ? 'text_delta' : 'thinking_delta',
                contentIndex: 0,
                delta,
                ...(index % 2
                  ? {}
                  : {
                      partial: {
                        role: 'assistant',
                        content: [],
                        usage: { input: index + 1, output: 1, cacheRead: 0, cacheWrite: 0 }
                      }
                    })
              }
            },
            1000 + performance.now()
          )
        )
      for (let i = 0; i < n; i++) {
        if (i) {
          await vi.advanceTimersByTimeAsync(1000 / n)
        }
        const before = { full: meter.full.length, estimates: meter.bodyEstimates }
        feed(body.slice((i * body.length) / n, ((i + 1) * body.length) / n), i)
        // The context preceding this delta cannot materialize named text, even when unplaced/due.
        expect(meter.full.length).toBe(before.full)
        expect(meter.bodyEstimates).toBe(before.estimates)
        await rig.eventSink.written?.()
      }
      await vi.advanceTimersByTimeAsync(1000 / n)
      await vi.advanceTimersByTimeAsync(500)
      const unchanged = meter.full.length
      lane.apply([
        { type: 'context.usage', usage: { used: { kind: 'unknown', capturedAt: 2500 } } }
      ])
      expect(meter.full.length).toBe(unchanged)
      const prefinal = inputs.filter(
        (row): row is JournalItemRow => row.kind === 'item' && row.body.kind === 'message'
      )
      const beforeFinal = meter.full.length
      lane.apply(
        messages.message(
          {
            type: 'message_end',
            message: {
              role: 'assistant',
              content:
                channel === 'assistant'
                  ? [{ type: 'text', text: body }]
                  : [{ type: 'thinking', thinking: body }]
            }
          },
          2000
        )
      )
      lane.apply([{ type: 'turn.end', at: 2000, state: 'completed', outcome: 'success' }])
      await lane.drained()
      await rig.eventSink.written?.()
      expect(failed).not.toHaveBeenCalled()
      const rows = rig.journal.snapshot().items
      const text = rows.filter((row) => row.body.kind === 'message')
      expect(text).toHaveLength(1)
      expect(text[0]?.body).toMatchObject({
        role: channel === 'assistant' ? 'assistant' : 'reasoning',
        blocks: [{ type: 'text', text: body }]
      })
      expect(prefinal.length).toBeLessThanOrEqual(3)
      expect(meter.full.length).toBeLessThanOrEqual(8)
      expect(meter.full.reduce((n, value) => n + Buffer.byteLength(value), 0)).toBeLessThanOrEqual(
        8 * body.length
      )
      expect(meter.visits).toBeLessThanOrEqual(4 * n + 12)
      const textInputs = inputs.filter(
        (row): row is JournalItemRow => row.kind === 'item' && row.body.kind === 'message'
      )
      const first = textInputs[0]
      expect(text[0]).toMatchObject({
        itemId: first.itemId,
        sequence: first.seq,
        observedAt: first.ts,
        turnScope: first.turnScope
      })
      expect(
        textInputs.every(
          (row) => row.itemId === first.itemId && row.turnScope?.kind === first.turnScope?.kind
        )
      ).toBe(true)
      observations.push({
        channel,
        n,
        bodySize,
        selectionVisits: meter.visits,
        fullMaterializations: meter.full.length,
        assembledBytes: meter.full.reduce((n, value) => n + Buffer.byteLength(value), 0),
        bodyEstimateCalls: meter.bodyEstimates,
        prefinalTextCommits: prefinal.length,
        committedTextInputs: textInputs.length,
        attemptedTransitions: append.mock.calls.length,
        admittedTransitions: append.mock.results.filter(
          (result) => result.type === 'return' && result.value.accepted
        ).length,
        committedMetadataInputs: inputs.filter(
          (row) => row.kind === 'item' && row.body.kind === 'turn'
        ).length,
        beforeFinal
      })
      const calibration = meter.full.length
      lane.apply([
        { type: 'text.delta', item: { id: 'boundary-control' }, channel, text: 'control' },
        {
          type: 'item.close',
          item: 'tool-control',
          body: { kind: 'tool-call', name: 'control', input: {}, state: 'completed' }
        }
      ])
      expect(meter.full.length).toBeGreaterThan(calibration)
      await rig.eventSink.written?.()
      await consumers(rig.journal)
      lane.dispose()
      const saved = structuredClone(rig.journal.snapshot().items)
      const reopened = await rig.reopenJournal()
      expect(reopened.snapshot().items).toEqual(saved)
      await consumers(reopened)
      vi.useRealTimers()
    }
  }
  for (const channel of ['assistant', 'reasoning'] as const) {
    const rig = await openProviderTimelineRig({ agent: 'pi' })
    rig.assembler.dispose()
    const lane = new JsonlRpcTimelineLane({
      sink: rig.sink,
      sessionId: 'session-timeline',
      agent: 'pi',
      generation: 'whitespace',
      namespace: 'whitespace',
      pauseReading: vi.fn(),
      resumeReading: vi.fn(),
      onInputAccepted: vi.fn(),
      onFailed: vi.fn()
    })
    disposals.push(() => lane.dispose())
    const messages = new PiRpcMessages('whitespace', new PiRpcContextUsage())
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] })
    lane.apply([{ type: 'turn.open', turn: 'white', at: 1 }])
    for (const delta of ['', ' ', '\n', '']) {
      const before = meter.full.length
      lane.apply(
        messages.message(
          {
            type: 'message_update',
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            assistantMessageEvent: {
              type: channel === 'assistant' ? 'text_delta' : 'thinking_delta',
              contentIndex: 0,
              delta
            }
          },
          2
        )
      )
      expect(meter.full.length).toBe(before)
    }
    await vi.advanceTimersByTimeAsync(1000)
    const before = meter.full.length
    lane.apply([{ type: 'context.usage', usage: { used: { kind: 'unknown', capturedAt: 1002 } } }])
    expect(meter.full.length).toBe(before)
    await rig.eventSink.written?.()
    expect(rig.journal.snapshot().items.filter((row) => row.body.kind === 'message')).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    lane.finalize()
    await rig.eventSink.written?.()
    lane.dispose()
    vi.useRealTimers()
  }
  for (const channel of ['assistant', 'reasoning']) {
    for (const n of [10, 100]) {
      const small = observations.find(
        (row) => row.channel === channel && row.n === n && row.bodySize === 1000
      )!
      const large = observations.find(
        (row) => row.channel === channel && row.n === n && row.bodySize === 10000
      )!
      expect(large.assembledBytes).toBeLessThanOrEqual(11 * small.assembledBytes)
      expect(large.committedTextInputs).toBeLessThanOrEqual(4)
    }
  }
  // A separate positive boundary calibration, outside the optimized intervals.
  const before = meter.bodyEstimates
  estimateStructuredAgentSessionItemBytes(
    { provider: 'legacy', agent: 'pi', sessionId: 'calibration', recordId: 'calibration' },
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'control' }] }
  )
  expect(meter.bodyEstimates).toBe(before + 1)
  console.info('metadata-work', JSON.stringify(observations))
})
