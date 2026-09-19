import { describe, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalRenderItem
} from '../../shared/agent-session-journal-types'
import {
  createDeferredStructuredAgentSessionEventSink,
  type StructuredAgentSessionEventTarget
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { CodexJournalGoals } from './codex-structured-journal-goals'
import { MAX_CODEX_GOAL_THREADS } from './codex-structured-journal-limits'

const THREAD = '01a08cc2-f96e-76d0-bb74-88b9bc0b03fc'

function goalFrame(goal: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    threadId: THREAD,
    turnId: 'turn-1',
    goal: {
      threadId: THREAD,
      objective: 'Keep the current scratch directory tidy.',
      status: 'active',
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1789067988,
      updatedAt: 1789067988,
      ...goal
    }
  }
}

function goalJournal(
  options: Parameters<typeof createDeferredStructuredAgentSessionEventSink>[0] = {}
) {
  let rowSequence = 0
  let publishes = 0
  let epochNumber = 1
  let visits = 0
  let visitedItems = 0
  const rows = new Map<string, AgentJournalRenderItem>()
  const writes: string[] = []
  const deferred = createDeferredStructuredAgentSessionEventSink(options)
  const journal = {
    get epoch() {
      return `epoch-${epochNumber}`
    },
    appendItem: async (identity: AgentJournalItemIdentity, body: AgentJournalItemBody) => {
      rowSequence += 1
      const itemId = agentJournalItemKey(identity)
      const existing = rows.get(itemId)
      const revision = (existing?.revision ?? 0) + 1
      writes.push(itemId)
      rows.set(itemId, {
        itemId,
        body,
        revision,
        sequence: existing?.sequence ?? rowSequence,
        observedAt: existing?.observedAt ?? rowSequence
      })
      return { cursor: { epoch: `epoch-${epochNumber}`, sequence: rowSequence }, itemId, revision }
    },
    snapshot: () => ({
      sessionId: 'session',
      cursor: { epoch: `epoch-${epochNumber}`, sequence: rowSequence },
      items: [...rows.values()].sort((left, right) => left.sequence - right.sequence),
      submissions: []
    }),
    visitItems: (visit: (itemId: string, sequence: number) => void) => {
      visits += 1
      for (const item of rows.values()) {
        visitedItems += 1
        visit(item.itemId, item.sequence)
      }
    }
  } as unknown as StructuredAgentSessionEventTarget['journal']
  const target = {
    journal,
    fence: 1,
    publish: () => {
      publishes += 1
    }
  }
  deferred.bind(target)
  return {
    sink: deferred.sink,
    writes,
    rows: () => journal.snapshot().items,
    publishes: () => publishes,
    visits: () => visits,
    visitedItems: () => visitedItems,
    seedProviderItems: (count: number) => {
      for (let index = 0; index < count; index += 1) {
        rowSequence += 1
        const identity = {
          provider: 'codex' as const,
          threadId: THREAD,
          turnId: `seed-${index}`,
          ordinal: 0
        }
        const itemId = agentJournalItemKey(identity)
        rows.set(itemId, {
          itemId,
          body: { kind: 'message', role: 'assistant', blocks: [] },
          revision: 1,
          sequence: rowSequence,
          observedAt: rowSequence
        })
      }
    },
    replaceEpoch: () => {
      epochNumber += 1
      rowSequence = 0
      rows.clear()
    },
    rebind: () => deferred.bind(target),
    unbind: deferred.unbind,
    drained: deferred.drained
  }
}

function texts(rows: readonly AgentJournalItemBody[]): string[] {
  return rows.map((row) => (row.kind === 'status' ? row.text : ''))
}

describe('codex goal lifecycle resume', () => {
  it('does not append a cleared snapshot when the journal has no prior goal occurrence', async () => {
    const journal = goalJournal()
    journal.unbind()
    const resumed = new CodexJournalGoals(journal.sink)

    expect(
      resumed.handle({
        threadId: THREAD,
        method: 'thread/goal/cleared',
        params: { threadId: THREAD, turnId: null, clearedAt: 1789068999 }
      })
    ).toEqual({ accepted: true })
    expect(journal.writes).toHaveLength(0)

    journal.rebind()
    await journal.drained()

    expect(journal.writes).toHaveLength(0)
    expect(journal.publishes()).toBe(0)
    resumed.dispose()
  })

  it('does not revisit durable history for accounting-only updates', async () => {
    const journal = goalJournal()
    const goals = new CodexJournalGoals(journal.sink)
    goals.handle({ threadId: THREAD, method: 'thread/goal/updated', params: goalFrame() })
    await journal.drained()
    const visits = journal.visits()

    for (let index = 1; index <= 10; index += 1) {
      goals.handle({
        threadId: THREAD,
        method: 'thread/goal/updated',
        params: goalFrame({
          tokensUsed: index * 1_000,
          timeUsedSeconds: index,
          updatedAt: 1789067988 + index
        })
      })
    }
    await journal.drained()

    expect(journal.visits()).toBe(visits)
    expect(journal.writes).toHaveLength(1)
    goals.dispose()
  })

  it('rebuilds dedupe state after the journal epoch is replaced', async () => {
    const journal = goalJournal()
    const goals = new CodexJournalGoals(journal.sink)
    const event = { threadId: THREAD, method: 'thread/goal/updated', params: goalFrame() }

    goals.handle(event)
    await journal.drained()
    expect(journal.writes).toHaveLength(1)

    journal.replaceEpoch()
    goals.handle(event)
    await journal.drained()

    expect(journal.writes).toHaveLength(2)
    expect(texts(journal.rows().map((row) => row.body))).toEqual([
      'Goal set: Keep the current scratch directory tidy.'
    ])
    expect(journal.visits()).toBe(2)
    goals.dispose()
  })

  it('visits a large journal once per epoch when thread churn exceeds the transient LRU', async () => {
    const journal = goalJournal()
    journal.seedProviderItems(10_000)
    const goals = new CodexJournalGoals(journal.sink)
    const threadCount = MAX_CODEX_GOAL_THREADS + 1
    const sendRound = () => {
      for (let index = 0; index < threadCount; index += 1) {
        goals.handle({
          threadId: `thread-${index}`,
          method: 'thread/goal/updated',
          params: goalFrame()
        })
      }
    }

    sendRound()
    await journal.drained()
    for (let round = 0; round < 10; round += 1) {
      sendRound()
    }
    await journal.drained()

    expect(journal.visits()).toBe(1)
    expect(journal.visitedItems()).toBe(10_000)
    expect(journal.writes).toHaveLength(threadCount)
    goals.dispose()
  })

  it('resolves queued thread transitions from one shared durable projection', async () => {
    const journal = goalJournal()
    journal.seedProviderItems(10_000)
    journal.unbind()
    const goals = new CodexJournalGoals(journal.sink)

    for (let index = 0; index < MAX_CODEX_GOAL_THREADS; index += 1) {
      goals.handle({
        threadId: `thread-${index}`,
        method: 'thread/goal/updated',
        params: goalFrame()
      })
    }
    expect(journal.visits()).toBe(0)

    journal.rebind()
    await journal.drained()

    expect(journal.visits()).toBe(1)
    expect(journal.visitedItems()).toBe(10_000)
    expect(journal.writes).toHaveLength(MAX_CODEX_GOAL_THREADS)
    goals.dispose()
  })

  it('retries a journal-derived transition after lifecycle backpressure', async () => {
    const journal = goalJournal({ watermarks: { maxLifecycleQueuedOperations: 1 } })
    const goals = new CodexJournalGoals(journal.sink)
    journal.unbind()

    expect(
      goals.handle({
        threadId: THREAD,
        method: 'thread/goal/updated',
        params: goalFrame()
      })
    ).toEqual({ accepted: true })
    expect(
      goals.handle({
        threadId: THREAD,
        method: 'thread/goal/updated',
        params: goalFrame({ status: 'paused' })
      })
    ).toEqual({ accepted: false, reason: 'backpressure' })

    journal.rebind()
    await journal.drained()
    expect(
      goals.handle({
        threadId: THREAD,
        method: 'thread/goal/updated',
        params: goalFrame({ status: 'paused' })
      })
    ).toEqual({ accepted: true })
    await journal.drained()

    expect(texts(journal.rows().map((row) => row.body))).toEqual([
      'Goal set: Keep the current scratch directory tidy.',
      'Goal paused: Keep the current scratch directory tidy.'
    ])
    goals.dispose()
  })

  it.each([
    {
      name: 'paused',
      beforeResume: ['active', 'paused'] as const,
      resumed: { method: 'thread/goal/updated', goal: { status: 'paused' } },
      expected: ['Goal set', 'Goal paused']
    },
    {
      name: 'cleared',
      beforeResume: ['active', 'cleared'] as const,
      resumed: { method: 'thread/goal/cleared', goal: {} },
      expected: ['Goal set', 'Goal cleared']
    },
    {
      name: 'active after a pause',
      beforeResume: ['active', 'paused', 'active'] as const,
      resumed: { method: 'thread/goal/updated', goal: { status: 'active' } },
      expected: ['Goal set', 'Goal paused', 'Goal set']
    }
  ])('does not duplicate a $name snapshot after translator recreation', async (scenario) => {
    const journal = goalJournal()
    const send = (
      goals: CodexJournalGoals,
      state: (typeof scenario.beforeResume)[number]
    ): void => {
      goals.handle({
        threadId: THREAD,
        method: state === 'cleared' ? 'thread/goal/cleared' : 'thread/goal/updated',
        params: state === 'cleared' ? { threadId: THREAD } : goalFrame({ status: state })
      })
    }

    const prior = new CodexJournalGoals(journal.sink)
    for (const state of scenario.beforeResume) {
      send(prior, state)
    }
    await journal.drained()
    const acceptedOccurrence = journal.writes.at(-1)
    const writesBeforeResume = journal.writes.length
    const publishesBeforeResume = journal.publishes()
    const acceptedBody = journal.rows().find((row) => row.itemId === acceptedOccurrence)?.body
    prior.dispose()
    journal.unbind()

    const resumed = new CodexJournalGoals(journal.sink)
    resumed.handle({
      threadId: THREAD,
      method: scenario.resumed.method,
      params:
        scenario.resumed.method === 'thread/goal/cleared'
          ? { threadId: THREAD, turnId: null, clearedAt: 1789068999 }
          : {
              ...goalFrame({
                ...scenario.resumed.goal,
                tokensUsed: 12_345,
                timeUsedSeconds: 42,
                updatedAt: 1789068999
              }),
              turnId: null
            }
    })
    expect(journal.writes).toHaveLength(writesBeforeResume)
    journal.rebind()
    await journal.drained()

    expect(texts(journal.rows().map((row) => row.body))).toEqual(
      scenario.expected.map((prefix) =>
        prefix === 'Goal cleared' ? prefix : `${prefix}: Keep the current scratch directory tidy.`
      )
    )
    expect(journal.writes).toHaveLength(writesBeforeResume)
    expect(journal.publishes()).toBe(publishesBeforeResume)
    expect(journal.writes.at(-1)).toBe(acceptedOccurrence)
    expect(journal.rows().find((row) => row.itemId === acceptedOccurrence)?.body).toEqual(
      acceptedBody
    )
    resumed.dispose()
  })
})
