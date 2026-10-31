import { afterEach, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../shared/agent-session-journal-types'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../shared/agent-session-journal-item-key'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import { agentSessionFailureFact } from '../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import {
  AGENT,
  SESSION,
  NAMESPACE,
  closeProviderTimelineRigs,
  openProviderTimelineRig,
  providerTurnItemId
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { DISPATCH_DOUBT_PROVIDER_EXITED } from '../native-chat/agent-session-journal/journal-dispatch-doubt-reasons'
import { isHistoricalProviderTimelineItem } from '../native-chat/agent-session-timeline/provider-timeline-history'
import { settleObservedExitForTest } from '../native-chat/agent-session-wire/structured-agent-session-observed-exit.test-fixture'
import { captureUnfinishedStructuredAgentSessionWork } from '../native-chat/agent-session-wire/structured-agent-session-unfinished-work'
import { createDeferredStructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  recordingStructuredAgentSessionLogger,
  testEventSinkLogging
} from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import {
  hasArrayKey,
  operationStack,
  type ViewWork
} from './acp-history-scaling-counts.test-fixture'
import { work } from './acp-history-scaling-operations.test-fixture'
import { catchUpAcpHistory } from './acp-history-catch-up'
import { dividers } from './acp-history-catch-up.test-support'
import {
  acpHistoryTurns,
  type AcpIdentifiedHistoryTurn,
  type AcpLoadHistoryFrame
} from './acp-history-replay'
import { translateHistoryTurn, type AcpHistoryScope } from './acp-history-translation'
import { matchAcpHistoryTurns } from './acp-history-turn-matching'
import { acpNamedTextKey } from './acp-turn-messages'
import { OPENCODE_ACP_DIALECT } from './acp-dialects/opencode-dialect'
import { GROK_ACP_DIALECT } from './acp-dialects/grok-dialect'
import * as historyBatch from '../native-chat/agent-session-wire/structured-agent-session-history-catch-up'
import { journalLifecycleMutationItemId } from '../native-chat/agent-session-journal/journal-lifecycle-mutation'

afterEach(closeProviderTimelineRigs)
const scope: AcpHistoryScope = {
  agent: AGENT,
  sessionId: SESSION,
  providerSessionId: NAMESPACE,
  identity: 'user-message-id',
  dialect: OPENCODE_ACP_DIALECT
}
const frame = (
  update: Record<string, unknown>,
  meta?: Record<string, unknown>
): AcpLoadHistoryFrame => ({
  method: 'session/update',
  params: { sessionId: NAMESPACE, update, ...(meta ? { _meta: meta } : {}) }
})
const user = (id: string, text: string) =>
  frame({ sessionUpdate: 'user_message_chunk', messageId: id, content: { type: 'text', text } })
const answer = (id: string) =>
  frame({
    sessionUpdate: 'agent_message_chunk',
    messageId: id,
    content: { type: 'text', text: 'answer' }
  })
const link = (id: string) =>
  frame({
    sessionUpdate: 'agent_message_chunk',
    messageId: id,
    content: { type: 'resource_link', uri: `file:///outside/${id}`, name: id }
  })
type Rig = Awaited<ReturnType<typeof openProviderTimelineRig>>

async function native(rig: Rig, id: string, text: string, proof?: string) {
  await rig.journal.appendSubmission({
    clientMessageId: id,
    payloadFingerprint: id,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] },
    fence: 1
  })
  await rig.journal.resolveDispatch({
    clientMessageId: id,
    fence: 1,
    state: 'accepted',
    providerIdentity: null
  })
  rig.assembler.apply({
    type: 'input.accepted',
    clientMessageId: id,
    requestedAt: 1000,
    join: { turn: id }
  })
  rig.assembler.apply({ type: 'turn.open', turn: id, at: 1000 })
  if (proof) {
    rig.assembler.apply({
      type: 'text.delta',
      item: { id: acpNamedTextKey(proof, 'assistant') },
      channel: 'assistant',
      text: 'answer',
      join: { thread: NAMESPACE, turn: id }
    })
    rig.assembler.flush()
  }
  rig.assembler.apply({ type: 'turn.end', turn: id, state: 'completed', at: 1100 })
  await rig.rows()
}

async function catchUp(rig: Pick<Rig, 'eventSink'>, frames: AcpLoadHistoryFrame[]) {
  const { logger, entries } = recordingStructuredAgentSessionLogger()
  await catchUpAcpHistory({
    ...scope,
    frames,
    sink: rig.eventSink,
    assertCurrent: () => {},
    logger
  })
  expect(entries).toEqual([])
}

async function repeat(rig: Rig, frames: AcpLoadHistoryFrame[]) {
  const before = await rig.rows()
  const reopened = await rig.reopenJournal()
  const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
  deferred.bind({ journal: reopened, fence: 1, publish: () => {} })
  try {
    const counts = await measureCatchUp({ eventSink: deferred.sink }, frames, false)
    expect(reopened.snapshot().items).toEqual(before)
    return counts
  } finally {
    deferred.close()
    await reopened.close()
  }
}

async function measureCatchUp(
  rig: Pick<Rig, 'eventSink'>,
  frames: AcpLoadHistoryFrame[],
  commit: boolean
) {
  const history = rig.eventSink.journalHistory?.()
  const journal = rig.eventSink.journalItems?.()
  const append = rig.eventSink.tryAppendTransition
  if (!history || !journal || !append) {
    throw new Error('expected bound real journal and transition sink')
  }
  // Both readers and the resolver receive the same journal; spying preserves identity and epoch.
  expect(history).toBe(journal)
  let retainedRows = 0
  history.visitItems(() => retainedRows++)
  const submissions = history.submissions().length
  const sources = acpHistoryTurns(frames, scope.identity)
  const dividerRecordId = historyBatch.continuedOutsideRecordId
  const createBatch = historyBatch.createHistoryCatchUpBatch
  const counts = await work(async (count) => {
    count.retainedRows = retainedRows
    count.submissions = submissions
    count.frames = frames.length
    count.inputUtf8Bytes = Buffer.byteLength(JSON.stringify(frames), 'utf8')
    count.candidates = sources.filter((source) => source.turn !== null).length
    count.translationObservations = sources.reduce(
      (sum, source) => sum + 1 + source.observations.length,
      0
    )
    count.candidateKeyUtf8Bytes = sources.reduce(
      (sum, source) => sum + Buffer.byteLength(source.turn ?? '', 'utf8'),
      0
    )
    const visit = history.visitItems
    const item = history.item
    const sends = history.submissions
    const canonical = journal.canonicalItemId
    const spies = [
      vi.spyOn(historyBatch, 'continuedOutsideRecordId').mockImplementation((anchor) => {
        count.dividerKeyBuilds++
        return dividerRecordId(anchor)
      }),
      vi.spyOn(historyBatch, 'createHistoryCatchUpBatch').mockImplementation(() => {
        const batch = createBatch()
        const finish = batch.finish
        batch.finish = (...args) => {
          const plan = finish(...args)
          count.expectations += plan.expectedItems?.length ?? 0
          return plan
        }
        return batch
      }),
      vi.spyOn(history, 'visitItems').mockImplementation((callback) => {
        const view: ViewWork = {
          visitedRows: 0,
          itemReads: 0,
          submissionReturns: 0,
          submissionCopies: 0,
          canonicalEntries: 0,
          canonicalReads: 0
        }
        count.views.push(view)
        visit.call(history, (...args) => {
          view.visitedRows++
          callback(...args)
        })
      }),
      vi.spyOn(history, 'item').mockImplementation((key) => {
        if (operationStack().includes('journalView')) {
          count.views.at(-1)!.itemReads++
        } else {
          count.otherItemReads++
        }
        return item.call(history, key)
      }),
      vi.spyOn(history, 'submissions').mockImplementation(() => {
        const result = sends.call(history)
        if (operationStack().includes('journalView')) {
          const view = count.views.at(-1)!
          view.submissionReturns++
          view.submissionCopies += result.length
        } else {
          count.otherSubmissionReturns++
          count.otherSubmissionCopies += result.length
        }
        return result
      }),
      vi.spyOn(journal, 'canonicalItemId').mockImplementation((key) => {
        const stack = operationStack()
        count.canonicalKeyUtf8Bytes += Buffer.byteLength(key, 'utf8')
        count.longestCanonicalKey = Math.max(count.longestCanonicalKey, key.length)
        if (stack.includes('journalView')) {
          count.views.at(-1)!.canonicalReads++
        } else if (stack.includes('structured-agent-session-history-catch-up.ts')) {
          count.resolverCanonicalReads++
        } else {
          count.otherCanonicalReads++
        }
        return canonical.call(journal, key)
      })
    ]
    const countedFrames = new Proxy(frames, {
      get(target, key) {
        if (key === Symbol.iterator) {
          return function* () {
            for (const frame of target) {
              count.frameVisits++
              yield frame
            }
          }
        }
        return hasArrayKey(target, key) ? target[key] : undefined
      }
    })
    try {
      await catchUp(
        {
          eventSink: {
            ...rig.eventSink,
            tryAppendTransition: (transition) =>
              append.call(rig.eventSink, {
                ...transition,
                steps: transition.steps.map((step) =>
                  step.kind !== 'settlement'
                    ? step
                    : {
                        ...step,
                        resolve: (current) => {
                          const mutations = step.resolve(current)
                          count.mutations += mutations.length
                          count.resolvedKeys.push(...mutations.map(journalLifecycleMutationItemId))
                          count.correctedDividers.push(
                            ...mutations.flatMap((mutation) =>
                              mutation.identity?.provider === 'legacy' &&
                              mutation.identity.recordId.startsWith('continued-outside:')
                                ? [agentJournalItemKey(mutation.identity)]
                                : []
                            )
                          )
                          return mutations
                        }
                      }
                )
              })
          }
        },
        countedFrames
      )
    } finally {
      for (const spy of spies) {
        spy.mockRestore()
      }
    }
  })
  expect(counts.frameVisits).toBe(frames.length)
  expect(counts.views).toHaveLength(commit ? 2 : 1)
  for (const view of counts.views) {
    expect(view.visitedRows).toBe(retainedRows)
    expect(view.itemReads).toBe(retainedRows)
    expect(view.submissionReturns).toBe(1)
    expect(view.submissionCopies).toBe(submissions)
    expect(view.canonicalReads).toBe(view.canonicalEntries)
  }
  expect(counts.resolverCanonicalReads).toBe(counts.mutations + counts.expectations)
  expect(counts.mutations > 0).toBe(commit)
  return counts
}

// Instrumented 20/200 journal settlement and disk reopens need extra CI time.
it('bounds composed fresh/held content and old dividers at 20 and 200', async () => {
  const populations: {
    first: Awaited<ReturnType<typeof measureCatchUp>>
    unchanged: Awaited<ReturnType<typeof measureCatchUp>>
  }[] = []
  for (const n of [20, 200]) {
    const rig = await openProviderTimelineRig()
    for (let i = 0; i < n; i++) {
      await native(rig, `native-${i}`, `native-${i}`)
    }
    const nativeRows = structuredClone(await rig.rows())
    const population = (size: number, text: string) =>
      Array.from({ length: size }, (_, i) => [
        user(`outside-${i}`, `outside-${i}`),
        frame({
          sessionUpdate: 'agent_message_chunk',
          messageId: `answer-${i}`,
          content: { type: 'text', text }
        })
      ]).flat()
    await catchUp(rig, population(n / 2, 'prefix'))
    for (let i = 0; i < n / 2; i++) {
      await rig.journal.appendItem(
        {
          provider: 'legacy',
          agent: AGENT,
          sessionId: SESSION,
          recordId: `continued-outside:outside-${i}`
        },
        historyBatch.continuedOutsideNotice(true),
        { fence: 1, turnScope: { kind: 'thread' } }
      )
    }
    const frames = [...population(n, 'middle'), ...population(n, 'final')]
    const first = await measureCatchUp(rig, frames, true)
    const after = await rig.rows()
    expect(after.slice(0, nativeRows.length)).toEqual(nativeRows)
    expect(dividers(after)).toHaveLength(0)
    expect(
      after.filter(
        (row) =>
          row.body.kind === 'message' &&
          row.body.role === 'assistant' &&
          row.body.blocks.some((block) => block.type === 'text' && block.text === 'final')
      )
    ).toHaveLength(n)
    expect(first.expectations).toBe(n)
    expect(new Set(first.resolvedKeys).size).toBe(first.mutations)
    expect(new Set(first.correctedDividers).size).toBe(n / 2)
    expect(first.correctedDividers).toHaveLength(n / 2)
    const unchanged = await repeat(rig, frames)
    expect(unchanged.expectations).toBe(0)
    expect(unchanged.mutations).toBe(0)
    populations.push({ first, unchanged })
  }
  for (const phase of ['first', 'unchanged'] as const) {
    for (const operation of [
      'dividerKeyBuilds',
      'compositionReads',
      'compositionWrites',
      'catchUp',
      'translationObservations',
      'translatedItems'
    ] as const) {
      const small = populations[0]![phase][operation]
      expect(small).toBeGreaterThan(0)
      // V8 coverage ranges vary after warmup; indexed source/composition counts are exact.
      const factor = operation === 'catchUp' ? 12 : 11
      expect(populations[1]![phase][operation]).toBeLessThanOrEqual(small * factor)
    }
  }
}, 120000)

// Real journal I/O across the 20/200 population matrix needs the extended timeout on CI.
it('bounds actual first/reopened search and repeated source activation at 20 and 200', async () => {
  const populations: {
    n: number
    k: number
    first: Awaited<ReturnType<typeof measureCatchUp>>
    unchanged: Awaited<ReturnType<typeof measureCatchUp>>
  }[] = []
  for (const n of [20, 200]) {
    for (const k of [0, 2 * n]) {
      const rig = await openProviderTimelineRig()
      for (let i = 0; i < k; i++) {
        await native(rig, `native-${i}`, `native-${i}`)
      }
      const before = structuredClone(await rig.rows())
      const frames = Array.from({ length: n }, (_, i) => user(`outside-${i}`, `outside-${i}`))
      const first = await measureCatchUp(rig, frames, true)
      const after = await rig.rows()
      expect(after.slice(0, before.length)).toEqual(before)
      expect(
        after.filter((row) => row.body.kind === 'message' && row.body.role === 'user')
      ).toHaveLength(n + k)
      expect(
        after
          .slice(before.length)
          .flatMap((row) =>
            row.body.kind === 'message' && row.body.role === 'user' ? [row.body.blocks] : []
          )
      ).toEqual(Array.from({ length: n }, (_, i) => [{ type: 'text', text: `outside-${i}` }]))
      expect(dividers(after)).toHaveLength(0)
      const unchanged = await repeat(rig, frames)
      for (const count of [first, unchanged]) {
        expect(count.suffix).toBeLessThanOrEqual(n * Math.ceil(Math.log2(n + 1)))
        expect(count.native).toBeLessThanOrEqual(2 * k + n * Math.ceil(Math.log2(k + 1)))
        expect(count.tree).toBeGreaterThan(0)
        expect(count.tree).toBeLessThan(32 * (n + k) * Math.ceil(Math.log2(n + k + 1)))
      }
      populations.push({ n, k, first, unchanged })
    }
    const rig = await openProviderTimelineRig()
    for (let i = 0; i < n; i++) {
      await native(rig, `native-${i}`, `a-${i}`)
    }
    await native(rig, 'end', 'end', 'end-proof')
    const before = structuredClone(await rig.rows())
    const frames = Array.from({ length: n }, (_, i) => [
      user(`A-${i}`, `a-${i}`),
      user(`Z-${i}`, `outside-${i}`),
      user(`A-${i}`, `a-${i}`)
    ]).flat()
    frames.push(user('E', 'end'), answer('end-proof'))
    const count = await measureCatchUp(rig, frames, true)
    const after = await rig.rows()
    expect(after.slice(0, before.length)).toEqual(before)
    expect(
      after
        .slice(before.length)
        .flatMap((row) => (row.body.kind === 'message' ? [row.body.blocks] : []))
    ).toEqual(Array.from({ length: n }, (_, i) => [{ type: 'text', text: `outside-${i}` }]))
    expect(count.tree).toBeLessThan(64 * n * Math.ceil(Math.log2(n + 1)))
    populations.push({ n, k: -1, first: count, unchanged: count })
  }
  for (const small of populations.filter((entry) => entry.n === 20)) {
    const large = populations.find(
      (entry) => entry.n === 200 && (small.k === -1 ? entry.k === -1 : entry.k === small.k * 10)
    )!
    expect(large.first.matching).toBeLessThan(small.first.matching * 20)
    expect(large.unchanged.matching).toBeLessThan(small.unchanged.matching * 20)
  }
}, 120000)

// Real journal writes and both projected views at 20/200 entries need the extended CI timeout.
it('bounds grouped IDs and rejected copies through real empty and committed views', async () => {
  for (const n of [20, 200]) {
    const rig = await openProviderTimelineRig()
    await native(rig, 'root', 'root', 'proof')
    const before = structuredClone(await rig.rows())
    // Link observations retain distinct source IDs without keeping 200 text streams open.
    const frames = [
      user('provider-root', 'root'),
      answer('proof'),
      ...Array.from({ length: n }, (_, i) => link(`part-${i}`))
    ]
    const grouped = await measureCatchUp(rig, frames, false)
    expect(grouped.membership).toBeGreaterThanOrEqual(n)
    expect(grouped.membership).toBeLessThanOrEqual(n + 2)
    expect(await rig.rows()).toEqual(before)
    const parsed = acpHistoryTurns(frames, 'user-message-id')
    expect(parsed[0].messageIds).toEqual([
      'provider-root',
      'proof',
      ...Array.from({ length: n }, (_, i) => `part-${i}`)
    ])
    const rejected = await openProviderTimelineRig()
    for (let i = 0; i < n; i++) {
      await rejected.journal.appendSubmission({
        clientMessageId: `r-${i}`,
        payloadFingerprint: 'same',
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'repeat' }] },
        fence: 1
      })
      await rejected.journal.resolveDispatch({
        clientMessageId: `r-${i}`,
        fence: 1,
        state: 'rejected',
        ...agentSessionFailureWords(agentSessionFailureFact('providerRejected'), {
          surface: 'rejection'
        })
      })
    }
    const seeded = structuredClone(await rejected.rows())
    const submissions = structuredClone(rejected.journal.submissions())
    const empty = await measureCatchUp(rejected, [], false)
    expect(await rejected.rows()).toEqual(seeded)
    const committed = await measureCatchUp(rejected, [user('outside', 'new')], true)
    const after = await rejected.rows()
    expect(after.slice(0, seeded.length)).toEqual(seeded)
    expect(
      after
        .slice(seeded.length)
        .flatMap((row) => (row.body.kind === 'message' ? [row.body.blocks] : []))
    ).toEqual([[{ type: 'text', text: 'new' }]])
    expect(rejected.journal.submissions()).toEqual(submissions)
    expect(empty.copies).toBeGreaterThan(2 * n)
    expect(empty.copies).toBeLessThan(16 * n)
    expect(committed.copies).toBe(empty.copies * 2)
  }
}, 120000)

it('preserves regressing floors, future exact reservations, ties and non-consuming misses', async () => {
  const rig = await openProviderTimelineRig()
  for (const [id, text, proof] of [
    ['a', 'a'],
    ['b', 'b'],
    ['B', 'high'],
    ['tie', 'tie'],
    ['empty', ''],
    ['end', 'end']
  ]) {
    await native(rig, id, text, proof)
  }
  const items = new Map((await rig.rows()).map((row) => [row.itemId, row]))
  const tie = items.get(providerTurnItemId('tie'))!
  const adopted = {
    itemId: agentJournalItemKey({
      provider: 'legacy',
      agent: AGENT,
      sessionId: NAMESPACE,
      recordId: 'Q'
    }),
    sequence: tie.sequence,
    revision: 1,
    observedAt: 0,
    body: {
      kind: 'message' as const,
      role: 'assistant' as const,
      blocks: [{ type: 'text' as const, text: 'retained' }]
    }
  }
  items.set(adopted.itemId, adopted)
  const before = structuredClone([...items.values()])
  const frames = [
    user('A', 'a'),
    user('B', 'high'),
    user('A', 'a'),
    user('C', 'b'),
    user('O', 'tie'),
    user('Q', 'adopted'),
    user('P', 'tie'),
    user('U', ''),
    user('end', 'end'),
    user('B', 'high'),
    user('Z', 'end')
  ]
  const candidates = acpHistoryTurns(frames, scope.identity)
    .filter((turn): turn is AcpIdentifiedHistoryTurn => turn.turn !== null)
    .map((source) => ({ source, items: translateHistoryTurn(scope, source) }))
  const result = matchAcpHistoryTurns(scope, { items }, candidates, null, new Set(), () => {})
  expect([...result.matched]).toEqual([
    ['B', 2],
    ['end', 5],
    ['A', 0],
    ['C', 1],
    ['P', 3],
    ['U', 4]
  ])
  expect(result.kind.get('Q')).toBe('adopted')
  expect(result.kind.has('O')).toBe(false)
  expect(result.kind.has('Z')).toBe(false)
  expect([...items.values()]).toEqual(before)
})

it('keeps Grok timestamp adoption and never enumerates its unread adopted maximum', async () => {
  const grok: AcpHistoryScope = { ...scope, identity: 'prompt-id', dialect: GROK_ACP_DIALECT }
  for (const n of [20, 200]) {
    const items = new Map(
      Array.from({ length: n }, (_, i): [string, AgentJournalRenderItem] => {
        const itemId = agentJournalItemKey({
          provider: 'legacy',
          agent: AGENT,
          sessionId: NAMESPACE,
          recordId: `old-${i}`
        })
        return [
          itemId,
          {
            itemId,
            sequence: i + 1,
            revision: 1,
            observedAt: 0,
            body: { kind: 'message', role: 'assistant', blocks: [] }
          }
        ]
      })
    )
    const frames = Array.from({ length: n }, (_, i) => [
      frame(
        {
          sessionUpdate: 'user_message_chunk',
          _meta: { promptIndex: i },
          content: { type: 'text', text: 'old' }
        },
        { agentTimestampMs: 500 }
      ),
      frame(
        {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'resource_link', uri: 'file:///outside/old' }
        },
        { promptId: `prompt-${i}` }
      )
    ]).flat()
    const candidates = acpHistoryTurns(frames, grok.identity)
      .filter((turn): turn is AcpIdentifiedHistoryTurn => turn.turn !== null)
      .map((source) => ({ source, items: translateHistoryTurn(grok, source) }))
    const count = await work(async () => {
      const result = matchAcpHistoryTurns(grok, { items }, candidates, 500, new Set(), () => {})
      expect([...result.kind.values()]).toEqual(Array.from({ length: n }, () => 'adopted'))
    })
    expect(count.adopted).toBe(0)
    expect(
      matchAcpHistoryTurns(grok, { items }, candidates, 499, new Set(), () => {}).kind.size
    ).toBe(0)
    expect(() =>
      matchAcpHistoryTurns(grok, { items }, candidates, null, new Set(), () => {})
    ).toThrow('no-legacy-origin')
  }
})

// Importing and settling real 20/200-entry journals needs the extended timeout on CI.
it('counts observed-exit provenance passes while preserving imported history at 20 and 200', async () => {
  for (const n of [20, 200]) {
    const rig = await openProviderTimelineRig()
    await catchUp(
      rig,
      Array.from({ length: n }, (_, i) => user(`archived-${i}`, 'past'))
    )
    const archival = structuredClone(await rig.rows())
    expect(archival).toHaveLength(2 * n)
    const archivedById = new Map(archival.map((row) => [row.itemId, row]))
    expect(
      archival.every((row) =>
        isHistoricalProviderTimelineItem(row, (key) => archivedById.get(key) ?? null)
      )
    ).toBe(true)
    await rig.journal.appendSubmission({
      clientMessageId: 'live',
      payloadFingerprint: 'live',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'working' }] },
      fence: 1
    })
    rig.assembler.apply({
      type: 'input.accepted',
      clientMessageId: 'live',
      requestedAt: 1000,
      join: { turn: 'live' }
    })
    rig.assembler.apply({ type: 'turn.open', turn: 'live', at: 1000 })
    const before = await rig.rows()
    const unfinished = captureUnfinishedStructuredAgentSessionWork(rig.journal)
    expect(unfinished.items.map((item) => item.itemId)).toEqual([providerTurnItemId('live')])
    expect(unfinished.hadUnsettledSubmissions).toBe(true)
    expect(
      before.find((row) => row.itemId === agentJournalSubmissionKey('live'))?.turnScope
    ).toEqual({
      kind: 'turn',
      turnItemId: archival.findLast((row) => readAgentJournalTurn(row.body))!.itemId
    })
    const snapshot = rig.journal.snapshot
    const batch = rig.journal.appendPlannedLifecycleBatch
    let batchCalls = 0
    let settlement: Awaited<ReturnType<typeof settleObservedExitForTest>> | undefined
    const submissionCount = rig.journal.submissions().length
    const counts = await work(async (count) => {
      count.retainedRows = before.length
      count.submissions = submissionCount
      rig.journal.observeCommits(() => count.commits++)
      const spies = [
        vi.spyOn(rig.journal, 'snapshot').mockImplementation(() => {
          const result = snapshot.call(rig.journal)
          const phase =
            operationStack()
              .split('\n')
              .find((line) =>
                /captureUnfinishedStructuredAgentSessionWork|planStructuredAgentSessionDeadGeneration|planStaleStructuredAgentSessionState/.test(
                  line
                )
              ) ?? 'other'
          count.snapshots.push({ phase: phase.trim(), rows: result.items.length })
          return result
        }),
        vi.spyOn(rig.journal, 'appendPlannedLifecycleBatch').mockImplementation((input) => {
          batchCalls++
          return batch.call(rig.journal, input)
        })
      ]
      try {
        settlement = await settleObservedExitForTest({
          journal: rig.journal,
          sessionId: SESSION,
          fence: 2,
          ownerFence: 1,
          settlementId: `observed-exit-${n}`,
          pendingSubmissionReason: DISPATCH_DOUBT_PROVIDER_EXITED,
          verdict: { state: 'interrupted', completedAt: 1200 },
          exit: { ownerFence: 1, observedAt: 1200 }
        })
      } finally {
        for (const spy of spies) {
          spy.mockRestore()
        }
        rig.journal.observeCommits(() => {})
      }
    })
    expect(settlement).toMatchObject({ ok: true })
    expect(batchCalls).toBe(1)
    expect(counts.commits).toBe(1)
    expect(counts.execution.map((pass) => pass.phase.replace(/.*at (\w+).*/, '$1'))).toEqual([
      'captureUnfinishedStructuredAgentSessionWork',
      'planStructuredAgentSessionDeadGeneration',
      'planStaleStructuredAgentSessionState'
    ])
    expect(counts.snapshots).toHaveLength(3)
    for (const pass of counts.execution) {
      expect(pass.construction).toBe(before.length)
      expect(pass.predicates).toBe(before.length)
      expect(pass.executionItemIds).toEqual([providerTurnItemId('live')])
      expect(pass.reciprocalReads).toBeLessThanOrEqual(2 * before.length)
    }
    expect(counts.snapshots.map((entry) => entry.rows)).toEqual([
      before.length,
      before.length,
      before.length
    ])
    const after = await rig.rows()
    expect(after.filter((row) => archivedById.has(row.itemId))).toEqual(archival)
    expect(
      readAgentJournalTurn(rig.journal.itemBody(providerTurnItemId('live')) ?? undefined)
    ).toMatchObject({ state: 'interrupted', completedAt: 1200 })
    expect(rig.journal.submissions()).toMatchObject([
      {
        clientMessageId: 'live',
        dispatchState: 'unknown',
        reason: DISPATCH_DOUBT_PROVIDER_EXITED
      }
    ])
    expect(
      after.filter((row) => row.body.kind === 'status' && row.body.tone === 'error')
    ).toHaveLength(1)
  }
}, 120000)
