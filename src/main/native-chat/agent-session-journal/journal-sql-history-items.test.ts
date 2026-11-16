import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
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

it('reads prompt aliases, lost acknowledgements, saved placement and removed rows for catch-up', async () => {
  const root = await mkdtemp(join(tmpdir(), 'journal-sql-history-items-'))
  roots.push(root)
  const { journalDatabase } = await openStructuredAgentSessionSqlJournalDatabase({
    stateDirectory: root,
    writerPath: journalSqlWorkerPath(),
    readerPath: journalSqlReaderPath(),
    logger: { warn: () => {}, error: () => {} }
  })
  databases.push(journalDatabase)
  const journal = await SqlAgentSessionJournal.open({
    database: journalDatabase,
    identity: {
      sessionId: 'session',
      workspaceId: 'workspace',
      hostId: 'host',
      agent: 'claude',
      providerHandle: claudeProviderHandle('provider', null)
    },
    now: () => 100
  })
  await journal.appendSubmission({
    clientMessageId: 'prompt',
    fence: 1,
    payloadFingerprint: 'prompt',
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'ask' }] }
  })
  const alias = { provider: 'claude' as const, sessionId: 'provider', uuid: 'prompt-uuid' }
  await journal.resolveDispatch({
    clientMessageId: 'prompt',
    state: 'accepted',
    providerIdentity: alias,
    fence: 1
  })
  const turn = { provider: 'orca' as const, clientMessageId: 'turn' }
  await journal.appendItem(
    turn,
    {
      kind: 'turn',
      turnId: 'turn',
      state: 'completed',
      userItemId: agentJournalItemKey(alias)
    },
    { fence: 1, turnScope: { kind: 'thread' } }
  )
  const answer = { provider: 'orca' as const, clientMessageId: 'answer' }
  await journal.appendItem(
    answer,
    {
      kind: 'message',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'answer' }]
    },
    { fence: 1, turnScope: { kind: 'turn', turnItemId: 'orca:turn' } }
  )

  expect(
    await journal.reads.claudeHistoryPrompts('session', [
      '3a7d39ae-9134-4c54-ac64-352e1e6d505e',
      'missing'
    ])
  ).toEqual([{ uuid: '3a7d39ae-9134-4c54-ac64-352e1e6d505e', itemId: 'orca:prompt' }])
  const items = await journal.reads.historyItems(
    [agentJournalItemKey(alias), 'orca:answer', 'missing'],
    { includeOpeners: true }
  )
  expect(items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        key: agentJournalItemKey(alias),
        canonicalItemId: 'orca:prompt',
        removed: false,
        openedTurnIds: ['orca:turn'],
        item: expect.objectContaining({
          itemId: 'orca:prompt',
          body: expect.objectContaining({ role: 'user' })
        })
      }),
      expect.objectContaining({
        key: 'orca:turn',
        item: expect.objectContaining({
          body: {
            kind: 'turn',
            turnId: 'turn',
            state: 'completed',
            userItemId: agentJournalItemKey(alias)
          }
        })
      }),
      expect.objectContaining({
        key: 'orca:answer',
        item: expect.objectContaining({ turnScope: { kind: 'turn', turnItemId: 'orca:turn' } })
      }),
      { key: 'missing', canonicalItemId: 'missing', item: null, removed: false }
    ])
  )
  await journal.appendTombstone(answer, { fence: 1 })
  expect(await journal.reads.historyItems(['orca:answer'])).toEqual([
    { key: 'orca:answer', canonicalItemId: 'orca:answer', item: null, removed: true }
  ])
})
