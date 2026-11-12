import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { agentSessionRecordFixture } from '../testing/agent-session-record-test-fixture'
import { encodeAgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record-stored-form'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import type { JournalAutomaticSelection } from './journal-automatic-submission'
import { automaticBody, automaticMail } from './journal-automatic-submission.test-fixture'
import { openJournalDatabase } from './database/journal-database'
import { journalDatabasePath } from './database/journal-host-database'
import { JournalSqlDatabase } from './database/journal-sql-database'
import { SqlAgentSessionJournal } from './journal-sql-store'
import {
  journalSqlReaderPath,
  journalSqlWorkerPath
} from './journal-sql-worker-bundle.test-fixture'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'journal-automatic-port-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const { db } = openJournalDatabase(journalDatabasePath(root))
  db.prepare('INSERT INTO agent_session_records(session_id,record_json) VALUES(?,?)').run(
    'chat-test',
    JSON.stringify(encodeAgentSessionRecord(agentSessionRecordFixture({ sessionId: 'chat-test' })))
  )
  db.close()
  const database = await JournalSqlDatabase.open(root, {
    writerPath: journalSqlWorkerPath(),
    readerPath: journalSqlReaderPath(),
    onMaintenanceError: () => {}
  })
  cleanups.push(() => database.close())
  const journal = await SqlAgentSessionJournal.open({
    database,
    now: () => 100,
    identity: {
      sessionId: 'chat-test',
      workspaceId: 'workspace',
      hostId: 'host',
      agent: 'codex',
      providerHandle: codexProviderHandle('thread')
    }
  })
  return { database, journal }
}

it('keeps live capture and custody through committed receipt adoption on the journal lane', async () => {
  const { database, journal } = await fixture()
  await journal.queuedMessages.insert({
    messageId: 'mail',
    body: { ...automaticBody('notice'), from: automaticMail },
    options: {}
  })
  const selection: JournalAutomaticSelection = {
    authority: {
      handle: journal.observationHandle(),
      record: {
        currentFence: 1,
        ownerObservation: { claimStatus: 'live', unreconciled: false, handoffStage: null }
      },
      child: null,
      handingOver: [],
      continuingUnadmitted: [],
      finalizing: [],
      openedThrough: journal.openingCursor(),
      operationalRevision: 0
    },
    child: null,
    steering: { kind: 'codex-unavailable' }
  }
  const started = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  let adopted = false
  const claiming = journal.claimAutomaticSubmission(
    { clientMessageId: 'send', fence: 1 },
    async () => {
      started.resolve()
      await resume.promise
      return selection
    },
    (source) => {
      expect(source).toEqual(automaticMail)
      return 'owed'
    },
    {
      stage: async () => ({
        effects: [
          {
            kind: 'receipt',
            scope: { kind: 'global' },
            receipt: {
              operationId: 'automatic',
              sessionId: 'chat-test',
              callerKey: 'caller',
              method: 'agentSession.send',
              fingerprint: 'mail',
              acceptedAt: 100,
              status: 'accepted',
              result: { kind: 'journal-row', epoch: 'unassigned', sequence: 0 }
            },
            row: { at: 'first', kinds: ['submission'], answer: 'journal-row' }
          }
        ],
        settle: (results) => {
          adopted = results !== undefined
        }
      })
    }
  )
  await started.promise
  const after = journal.readInOrder(async (reads) => {
    expect(adopted).toBe(true)
    return reads.submission('send')
  })
  resume.resolve()
  expect(await claiming).toEqual({ kind: 'claimed', messageId: 'mail', clientMessageId: 'send' })
  expect(await after).toMatchObject({
    clientMessageId: 'send',
    queuedMessageId: 'mail',
    options: {}
  })
  expect(await journal.reads.submissionBody('send')).toMatchObject({
    blocks: [{ type: 'text', text: 'notice' }],
    from: automaticMail
  })
  expect(await database.readCommandReceipt({ kind: 'global' }, 'automatic')).toMatchObject({
    verdict: 'readable',
    receipt: { result: { kind: 'journal-row', sequence: 2 } }
  })
  await journal.close()
})
