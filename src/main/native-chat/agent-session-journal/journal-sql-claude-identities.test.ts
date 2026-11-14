import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { AgentJournalItemBody } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { claudeProviderHandle } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
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

const text = (value: string): AgentJournalItemBody => ({
  kind: 'message',
  role: 'assistant',
  blocks: [{ type: 'text', text: value }]
})
const thread = { kind: 'thread' as const }

it('snapshots saved Claude aliases, attempts and roster from indexed columns', async () => {
  const root = await mkdtemp(join(tmpdir(), 'journal-sql-claude-identities-'))
  roots.push(root)
  const { journalDatabase } = await openStructuredAgentSessionSqlJournalDatabase({
    stateDirectory: root,
    writerPath: journalSqlWorkerPath(),
    readerPath: journalSqlReaderPath(),
    logger: { warn: () => {}, error: () => {} }
  })
  databases.push(journalDatabase)
  const sql = await SqlAgentSessionJournal.open({
    database: journalDatabase,
    identity: {
      sessionId: 'session',
      workspaceId: 'workspace',
      hostId: 'host',
      agent: 'claude',
      providerHandle: claudeProviderHandle('claude-session', null)
    },
    now: () => 100
  })
  const row = (id: string) => ({ provider: 'orca' as const, clientMessageId: id })
  await sql.appendItem(
    row('roster'),
    {
      kind: 'message',
      role: 'assistant',
      blocks: [{ type: 'subagent', id: 'agent-a', label: 'A', state: 'working', groupId: 'turn' }]
    },
    { fence: 1, turnScope: thread }
  )
  await sql.appendItem(row('a1'), text('a'), {
    fence: 1,
    turnScope: thread,
    agentId: 'agent-a',
    providerParentRef: 'toolu_1',
    producerKind: 'agent'
  })
  // A provisional self-stamp records an attempt but no alias.
  await sql.appendItem(row('a3'), text('a again'), {
    fence: 1,
    turnScope: thread,
    agentId: 'agent-a',
    providerParentRef: 'agent-a',
    producerKind: 'agent',
    attempt: 3
  })
  // The later alias for the same tool call wins.
  await sql.appendItem(row('b1'), text('b'), {
    fence: 1,
    turnScope: thread,
    agentId: 'agent-b',
    providerParentRef: 'toolu_1',
    producerKind: 'agent'
  })

  expect(await sql.reads.claudeSnapshot()).toEqual({
    canonicalByToolUse: [['toolu_1', 'agent-b']],
    attemptByAgent: expect.arrayContaining([
      ['agent-a', 3],
      ['agent-b', 1]
    ]),
    subagents: ['agent-a'],
    parents: [
      [
        'agent-a',
        [
          [
            'toolu_1',
            expect.objectContaining({
              agentId: 'agent-a',
              providerParentRef: 'toolu_1',
              producerKind: 'agent'
            })
          ],
          [
            'agent-a',
            expect.objectContaining({
              agentId: 'agent-a',
              providerParentRef: 'agent-a',
              producerKind: 'agent',
              attempt: 3
            })
          ]
        ]
      ],
      [
        'agent-b',
        [
          [
            'toolu_1',
            expect.objectContaining({
              agentId: 'agent-b',
              providerParentRef: 'toolu_1',
              producerKind: 'agent'
            })
          ]
        ]
      ]
    ],
    backgrounds: [],
    threadGoal: { goal: null, row: null }
  })
})
