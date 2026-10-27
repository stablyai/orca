import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session-journal-types'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  AgentJournalCursor,
  AgentSessionJournalIdentity
} from '../../shared/agent-session-journal-types'
import { currentAgentSessionThreadGoal } from '../../shared/agent-session-thread-goal'
import type { AgentSessionHistoryPage } from '../../shared/agent-session-wire'
import type { AgentSessionJournal } from '../native-chat/agent-session-journal/journal-store'
import { createTrackedJournalOpener } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { readAgentSessionHistory } from '../native-chat/agent-session-wire/agent-session-history-page'
import { createDeferredStructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { CodexJournalGoals } from './codex-structured-journal-goals'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import { testEventSinkLogging } from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import { codexProviderHandle } from '../../shared/agent-session-provider-handle-encoding'

const THREAD = '01a08cc2-f96e-76d0-bb74-88b9bc0b03fc'
const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: codexProviderHandle(THREAD)
}

let root: string | null = null
const journals = createTrackedJournalOpener()

afterEach(async () => {
  await journals.closeAll()
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = null
  }
})

function goalFrame(goal: Record<string, unknown> = {}) {
  return {
    threadId: THREAD,
    turnId: null,
    goal: {
      threadId: THREAD,
      objective: 'Ship the parser',
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

function journalSink(journal: AgentSessionJournal) {
  const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
  const published: AgentSessionHistoryPage[] = []
  let subscriberCursor: AgentJournalCursor | null = null
  deferred.bind({
    journal,
    fence: 1,
    publish: () => {
      if (subscriberCursor === null) {
        return
      }
      const result = readAgentSessionHistory(journal, {
        sessionId: IDENTITY.sessionId,
        direction: 'after',
        cursor: subscriberCursor
      })
      if (result.ok) {
        published.push(result.page)
      }
    }
  })
  return {
    sink: deferred.sink,
    drained: () => deferred.drained(),
    subscribe: () => {
      subscriberCursor = journal.cursor()
    },
    published
  }
}

describe('codex goal accounting revisions', () => {
  it('projects recorded Codex 0.163.0 goal controls through the journal to the banner state', async () => {
    // Actual UI Set/Pause/Resume/Edit/Clear notifications; only provider IDs are redacted.
    const notifications: {
      receivedAt: string
      frame: { method: string; params: { threadId: string }; emittedAtMs: number }
    }[] = readFileSync(
      join(__dirname, '__fixtures__', 'codex-app-server-goal-lifecycle.jsonl'),
      'utf8'
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const threadId = '<threadId-1>'
    root = await mkdtemp(join(tmpdir(), 'orca-goal-recorded-'))
    const journal = await journals.open({
      identity: { ...IDENTITY, providerHandle: codexProviderHandle(threadId) },
      stateDirectory: root
    })
    const { sink, drained } = journalSink(journal)
    const translator = createCodexJournalTranslator({
      sink,
      sessionId: IDENTITY.sessionId,
      primaryThreadId: () => threadId
    })
    const projected: ReturnType<typeof currentAgentSessionThreadGoal>[] = []
    for (const { receivedAt, frame } of notifications) {
      expect(
        translator.handle({
          type: 'notification',
          sessionId: IDENTITY.sessionId,
          threadId: frame.params.threadId,
          method: frame.method,
          params: frame.params,
          observedAt: Date.parse(receivedAt)
        })
      ).toEqual({ accepted: true })
      await drained()
      projected.push(currentAgentSessionThreadGoal(journal.snapshot().items))
    }
    const original = {
      objective:
        'Inspect each of samples/sample-01.txt through sample-12.txt in order using a separate read for each, then compare inventory.txt and README.md and report a 12-row summary. No file edits or external network.',
      status: 'active',
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1792823727_000,
      updatedAt: 1792823727_000
    }
    expect(projected).toEqual([
      original,
      { ...original, status: 'paused', updatedAt: 1792823728_000 },
      { ...original, updatedAt: 1792823737_000 },
      null,
      {
        ...original,
        objective:
          'Inspect samples/sample-12.txt through samples/sample-01.txt in reverse order using a separate read for each, compare their fruit with inventory.txt, and report a reverse-order 12-row summary. No edits or external network.',
        createdAt: 1792823753_000,
        updatedAt: 1792823753_000
      },
      null
    ])
    translator.dispose()
  })

  it('revises the goal row in place: one visible row, pinned sequence, fresh counters', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-goal-revision-'))
    const journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
    await journal.appendItem(
      { provider: 'orca', clientMessageId: 'earlier' },
      { kind: 'status', text: 'Context compacted' },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    const { sink, drained, subscribe, published } = journalSink(journal)
    const goals = new CodexJournalGoals(sink, () => ({ turnScope: AGENT_JOURNAL_THREAD_SCOPE }))

    goals.handle({ threadId: THREAD, method: 'thread/goal/updated', params: goalFrame() })
    await drained()
    const [, created] = journal.snapshot().items
    await journal.appendItem(
      { provider: 'orca', clientMessageId: 'later' },
      { kind: 'status', text: 'Something after the goal' },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    subscribe()

    goals.handle({
      threadId: THREAD,
      method: 'thread/goal/updated',
      params: goalFrame({ timeUsedSeconds: 10, updatedAt: 1789067998 })
    })
    await drained()
    expect(journal.snapshot().items[1]?.revision).toBe(created?.revision)
    expect(published).toEqual([])

    goals.handle({
      threadId: THREAD,
      method: 'thread/goal/updated',
      params: goalFrame({ tokensUsed: 900, timeUsedSeconds: 45, updatedAt: 1789068033 })
    })
    await drained()

    const items = journal.snapshot().items
    expect(items.map((item) => item.itemId)).toEqual([
      'orca:earlier',
      created?.itemId,
      'orca:later'
    ])
    const revised = items[1]
    expect(revised?.sequence).toBe(created?.sequence)
    expect(revised?.revision).toBe((created?.revision ?? 0) + 1)
    expect(currentAgentSessionThreadGoal(items)).toMatchObject({
      tokensUsed: 900,
      timeUsedSeconds: 45,
      updatedAt: 1789068033_000
    })
    expect(published).toEqual([
      expect.objectContaining({
        items: [
          expect.objectContaining({
            itemId: created?.itemId,
            sequence: created?.sequence,
            revision: (created?.revision ?? 0) + 1
          })
        ],
        removedItemIds: []
      })
    ])
    goals.dispose()
  })

  it('refreshes the row from a resume snapshot of the same goal', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-goal-resume-revision-'))
    const journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
    const first = journalSink(journal)
    const prior = new CodexJournalGoals(first.sink, () => ({
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    }))
    prior.handle({ threadId: THREAD, method: 'thread/goal/updated', params: goalFrame() })
    await first.drained()
    prior.dispose()
    const [created] = journal.snapshot().items

    const second = journalSink(journal)
    const resumed = new CodexJournalGoals(second.sink, () => ({
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    }))
    // Resume snapshots refresh even inside the live revision interval.
    const snapshot = goalFrame({ timeUsedSeconds: 3, updatedAt: 1789067991 })
    resumed.handle({ threadId: THREAD, method: 'thread/goal/updated', params: snapshot })
    await second.drained()
    resumed.handle({ threadId: THREAD, method: 'thread/goal/updated', params: snapshot })
    await second.drained()

    const items = journal.snapshot().items
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      itemId: created?.itemId,
      sequence: created?.sequence,
      revision: (created?.revision ?? 0) + 1
    })
    expect(currentAgentSessionThreadGoal(items)?.timeUsedSeconds).toBe(3)
    resumed.dispose()
  })
})
