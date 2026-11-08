import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalApprovalItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { agentJournalTurnBody } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { openStructuredAgentSessionSqlJournalDatabase } from '../../runtime/agent-session/structured-agent-session-journal-open'
import type { JournalSqlDatabase } from './database/journal-sql-database'
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
  expect(await sql.appendSteps([open, open])).toEqual({
    outcomes: [{ kind: 'committed', wrote: true }, { kind: 'dropped' }]
  })
  const held = await sql.reads.item(firstRequest)
  expect(held?.body).toEqual(pending)
  // Another writer records the user's answer; the reused request ID opens a second incarnation.
  await sql.appendItem(requestRow, answered, { fence: 1, turnScope: inTurn })
  expect(await sql.appendSteps([open])).toEqual({ outcomes: [{ kind: 'committed', wrote: true }] })
  expect(
    await sql.appendSteps([
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
