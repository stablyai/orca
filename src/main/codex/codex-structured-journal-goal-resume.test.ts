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
  let scans = 0
  const rows = new Map<string, AgentJournalRenderItem>()
  const writes: string[] = []
  const deferred = createDeferredStructuredAgentSessionEventSink(options)
  const journal = {
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
      return { cursor: { epoch: 'epoch', sequence: rowSequence }, itemId, revision }
    },
    snapshot: () => ({
      sessionId: 'session',
      cursor: { epoch: 'epoch', sequence: rowSequence },
      items: [...rows.values()].sort((left, right) => left.sequence - right.sequence),
      submissions: []
    }),
    latestItemIdMatching: (matches: (itemId: string) => boolean) => {
      scans += 1
      return (
        [...rows.values()]
          .filter((item) => matches(item.itemId))
          .sort((left, right) => right.sequence - left.sequence)[0]?.itemId ?? null
      )
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
    scans: () => scans,
    rebind: () => deferred.bind(target),
    unbind: deferred.unbind,
    drained: deferred.drained
  }
}

function texts(rows: readonly AgentJournalItemBody[]): string[] {
  return rows.map((row) => (row.kind === 'status' ? row.text : ''))
}

describe('codex goal lifecycle resume', () => {
  it('does not scan durable history for accounting-only updates', async () => {
    const journal = goalJournal()
    const goals = new CodexJournalGoals(journal.sink)
    goals.handle({ threadId: THREAD, method: 'thread/goal/updated', params: goalFrame() })
    await journal.drained()
    const scans = journal.scans()

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

    expect(journal.scans()).toBe(scans)
    expect(journal.writes).toHaveLength(1)
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
