import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalApprovalItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { agentJournalTurnBody } from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { openStructuredAgentSessionSqlJournalDatabase } from '../../runtime/agent-session/structured-agent-session-journal-open'
import type { JournalSqlDatabase } from './database/journal-sql-database'
import { claudeBackgroundTaskIdentity } from '../../claude/background-tasks/claude-background-task-identity'
import {
  codexGoalJournalDigest,
  codexGoalJournalIdentity
} from '../../codex/structured/journal/codex-goal-journal-identity'
import { SqlAgentSessionJournal } from './journal-sql-store'
import {
  journalSqlReaderPath,
  journalSqlWorkerPath
} from './journal-sql-worker-bundle.test-fixture'

const roots: string[] = []
const databases: JournalSqlDatabase[] = []
afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function journal(): Promise<SqlAgentSessionJournal> {
  const root = await mkdtemp(join(tmpdir(), 'journal-sql-timeline-'))
  roots.push(root)
  const { journalDatabase } = await openStructuredAgentSessionSqlJournalDatabase({
    stateDirectory: root,
    writerPath: journalSqlWorkerPath(),
    readerPath: journalSqlReaderPath(),
    logger: { warn: () => {}, error: () => {} }
  })
  databases.push(journalDatabase)
  return SqlAgentSessionJournal.open({
    database: journalDatabase,
    identity: {
      sessionId: 'session',
      workspaceId: 'workspace',
      hostId: 'host',
      agent: 'codex',
      providerHandle: codexProviderHandle('thread')
    },
    now: () => 100
  })
}

const turn = { provider: 'orca' as const, clientMessageId: 'turn' }
const inTurn = { kind: 'turn' as const, turnItemId: agentJournalItemKey(turn) }
const request = { agent: 'grok' as const, sessionId: 'session', generation: 'g1', key: 'p1' }
const pending: AgentJournalApprovalItem = {
  kind: 'approval',
  title: 'Run?',
  detail: null,
  options: [{ id: 'allow', label: 'Allow' }],
  resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
}
const answered: AgentJournalApprovalItem = {
  ...pending,
  resolution: { state: 'resolved', selectedOptionId: 'allow', resolvedBy: 'user', resolvedAt: 50 }
}
const requestRow = {
  provider: 'legacy' as const,
  agent: 'grok' as const,
  sessionId: 'session',
  recordId: 'request:g:g1:p1'
}
const firstRequest = agentJournalItemKey(requestRow)

async function appendOutcomes(
  sql: SqlAgentSessionJournal,
  steps: Parameters<SqlAgentSessionJournal['appendSteps']>[0]
) {
  return { outcomes: (await sql.appendSteps(steps)).outcomes }
}

it('chooses request incarnations and settles the session from its unsettled rows on the writer', async () => {
  const sql = await journal()
  await sql.appendItem(
    turn,
    agentJournalTurnBody({ turnId: 'turn', state: 'running', userItemId: 'orca:turn' }),
    { fence: 1, turnScope: { kind: 'thread' } }
  )
  await sql.appendItem(
    { provider: 'orca', clientMessageId: 'tool' },
    { kind: 'tool-call', name: 'read', input: {}, state: 'running' },
    { fence: 1, turnScope: inTurn }
  )
  const open = {
    kind: 'resolved-item' as const,
    resolution: {
      kind: 'request-open' as const,
      request,
      body: pending,
      turnItemId: inTurn.turnItemId
    },
    options: { fence: 1, turnScope: inTurn, lifecycle: true },
    reservedBytes: 8192
  }
  // A duplicate open while the first incarnation is pending writes nothing.
  expect(await appendOutcomes(sql, [open, open])).toEqual({
    outcomes: [{ kind: 'committed', wrote: true }, { kind: 'dropped' }]
  })
  const held = await sql.reads.item(firstRequest)
  expect(held?.body).toEqual(pending)
  // Another writer records the user's answer; the reused request ID opens a second incarnation.
  await sql.appendItem(requestRow, answered, { fence: 1, turnScope: inTurn })
  expect(await appendOutcomes(sql, [open])).toEqual({
    outcomes: [{ kind: 'committed', wrote: true }]
  })
  expect(
    await appendOutcomes(sql, [
      {
        kind: 'settlement',
        settlementId: 'session-end',
        fence: 1,
        recovered: true,
        reservedBytes: 64 * 1024,
        resolution: {
          kind: 'timeline-settlement',
          scope: 'session',
          ending: { turns: 'running', end: { state: 'interrupted', completedAt: 300 } },
          keep: []
        }
      }
    ])
  ).toEqual({ outcomes: [{ kind: 'committed', wrote: true }] })

  expect((await sql.reads.item(firstRequest))?.body).toEqual(answered)
  const secondRequest = agentJournalItemKey({ ...requestRow, recordId: 'request:g:g1:p1#2' })
  expect((await sql.reads.item(secondRequest))?.body).toMatchObject({
    resolution: { state: 'cancelled' }
  })
  expect((await sql.reads.item('orca:tool'))?.body).not.toMatchObject({ state: 'running' })
  expect((await sql.reads.item('orca:turn'))?.body).toMatchObject({
    state: 'interrupted',
    completedAt: 300
  })
})

it("follows a thread's newest saved goal row when choosing a goal identity", async () => {
  const sql = await journal()
  const goal = (timeUsedSeconds: number, objective = 'Ship it') => ({
    kind: 'status' as const,
    text: `Goal set: ${objective}`,
    threadGoal: {
      state: 'set' as const,
      goal: {
        objective,
        status: 'active' as const,
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds,
        createdAt: 1,
        updatedAt: timeUsedSeconds
      }
    }
  })
  const thread = 'a'.repeat(64)
  const step = (signature: string, body: ReturnType<typeof goal>) => ({
    kind: 'resolved-item' as const,
    resolution: {
      kind: 'thread-goal' as const,
      choice: { thread, signature, body, requirePrevious: false }
    },
    options: { fence: 1, turnScope: { kind: 'thread' as const }, lifecycle: true },
    reservedBytes: 8192
  })
  const first = 'b'.repeat(64)
  const second = 'c'.repeat(64)
  expect(await appendOutcomes(sql, [step(first, goal(0)), step(first, goal(0))])).toEqual({
    outcomes: [{ kind: 'committed', wrote: true }, { kind: 'dropped' }]
  })
  expect(await appendOutcomes(sql, [step(first, goal(60)), step(second, goal(0, 'Next'))])).toEqual(
    {
      outcomes: [
        { kind: 'committed', wrote: true },
        { kind: 'committed', wrote: true }
      ]
    }
  )
  const occurrence = codexGoalJournalDigest(JSON.stringify([thread, first]))
  const firstRow = agentJournalItemKey(codexGoalJournalIdentity(thread, first, occurrence))
  const secondRow = agentJournalItemKey(
    codexGoalJournalIdentity(
      thread,
      second,
      codexGoalJournalDigest(JSON.stringify([occurrence, second]))
    )
  )
  expect(await sql.reads.item(firstRow)).toMatchObject({
    revision: 2,
    body: { threadGoal: { goal: { timeUsedSeconds: 60 } } }
  })
  expect(await sql.reads.item(secondRow)).toMatchObject({
    revision: 1,
    body: { text: 'Goal set: Next' }
  })
})

it("chooses a background task's generation from its saved incarnations on the writer", async () => {
  const sql = await journal()
  const task = (state: 'working' | 'done', parentToolUseId: string) => ({
    kind: 'resolved-item' as const,
    resolution: {
      kind: 'background-task' as const,
      taskId: 'task-1',
      toolUseId: parentToolUseId,
      body: {
        kind: 'message' as const,
        role: 'system' as const,
        blocks: [
          {
            type: 'background-task' as const,
            taskId: 'task-1',
            kind: 'command' as const,
            label: 'Build',
            state,
            parentToolUseId
          }
        ]
      }
    },
    options: { fence: 1, turnScope: { kind: 'thread' as const } },
    reservedBytes: 8192
  })
  await appendOutcomes(sql, [
    task('working', 'tool-1'),
    task('done', 'tool-1'),
    task('working', 'tool-2')
  ])
  const first = agentJournalItemKey(claudeBackgroundTaskIdentity('task-1'))
  const second = agentJournalItemKey(claudeBackgroundTaskIdentity('task-1', 2))
  expect(await sql.reads.item(first)).toMatchObject({
    revision: 2,
    body: { blocks: [{ state: 'done', parentToolUseId: 'tool-1' }] }
  })
  expect(await sql.reads.item(second)).toMatchObject({
    revision: 1,
    body: { blocks: [{ state: 'working', parentToolUseId: 'tool-2' }] }
  })
})
