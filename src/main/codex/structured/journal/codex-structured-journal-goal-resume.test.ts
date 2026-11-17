import { readTestJournalItems } from '../../../native-chat/agent-session-journal/journal-observation.test-support'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentJournalItemBody } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { createDeferredStructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { CodexJournalGoals } from './codex-structured-journal-goals'
import { createTrackedJournalOpener } from '../../../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { codexProviderHandle } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { testEventSinkLogging } from '../../../native-chat/agent-session-wire/host/testing/structured-agent-session-logger.test-fixture'

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

const journals = createTrackedJournalOpener()
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-codex-goal-resume-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

async function goalJournal() {
  const journal = await journals.open({
    identity: {
      sessionId: 'session',
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: codexProviderHandle(THREAD)
    },
    stateDirectory: root
  })
  const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
  const target = {
    journal,
    fence: 1,
    publish: () => {}
  }
  deferred.bind(target)
  const rows = () => readTestJournalItems(journal)
  return {
    sink: deferred.sink,
    rows,
    goalRowId: async () => (await rows()).findLast((row) => row.body.kind === 'status')?.itemId,
    replaceEpoch: () =>
      journal.write({ kind: 'epoch-replace', reason: 'handle_forked', fence: 1, items: [] }),
    rebind: () => deferred.bind(target),
    unbind: deferred.unbind,
    drained: deferred.drained
  }
}

function texts(rows: readonly AgentJournalItemBody[]): string[] {
  return rows.map((row) => (row.kind === 'status' ? row.text : ''))
}

describe('codex goal lifecycle resume', () => {
  it('rebuilds dedupe state after the journal epoch is replaced', async () => {
    const journal = await goalJournal()
    const goals = new CodexJournalGoals(journal.sink, () => ({
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    }))
    const event = { threadId: THREAD, method: 'thread/goal/updated', params: goalFrame() }

    goals.handle(event)
    await journal.drained()
    expect(await journal.rows()).toHaveLength(1)

    await journal.replaceEpoch()
    expect(await journal.rows()).toEqual([])
    goals.handle(event)
    await journal.drained()

    expect(texts((await journal.rows()).map((row) => row.body))).toEqual([
      'Goal set: Keep the current scratch directory tidy.'
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
    const journal = await goalJournal()
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

    const prior = new CodexJournalGoals(journal.sink, () => ({
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    }))
    for (const state of scenario.beforeResume) {
      send(prior, state)
    }
    await journal.drained()
    const acceptedOccurrence = await journal.goalRowId()
    const acceptedBody = (await journal.rows()).find(
      (row) => row.itemId === acceptedOccurrence
    )?.body
    prior.dispose()
    journal.unbind()

    const resumed = new CodexJournalGoals(journal.sink, () => ({
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    }))
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
    journal.rebind()
    await journal.drained()

    expect(texts((await journal.rows()).map((row) => row.body))).toEqual(
      scenario.expected.map((prefix) =>
        prefix === 'Goal cleared' ? prefix : `${prefix}: Keep the current scratch directory tidy.`
      )
    )
    // Fresh resume accounting revises the existing row; cleared goals carry none.
    const cleared = scenario.resumed.method === 'thread/goal/cleared'
    expect(await journal.goalRowId()).toBe(acceptedOccurrence)
    const revised = (await journal.rows()).find((row) => row.itemId === acceptedOccurrence)
    if (cleared) {
      expect(revised?.body).toEqual(acceptedBody)
    } else {
      expect(revised?.body).toMatchObject({
        text: acceptedBody?.kind === 'status' ? acceptedBody.text : undefined,
        threadGoal: { goal: { tokensUsed: 12_345, timeUsedSeconds: 42 } }
      })
    }
    resumed.dispose()
  })
})
