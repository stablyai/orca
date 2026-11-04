import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { readPublishedQueuedMessages } from '../agent-session-wire/structured-agent-session-queued-publication'
import { withMailDisplayReports } from '../agent-session-wire/mail-display-response'
import * as sourceFacts from '../../../shared/agent-session/agent-session-message-source'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { claudeProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { composeJournalOperationReceipts } from './journal-row-writer'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase,
  closeTestJournalHostDatabases,
  closeTestJournalHostDatabase
} from './journal-host-database-test-support'

const tracked = createTrackedJournalOpener()
const identity = {
  sessionId: 'mail-display-test',
  workspaceId: 'ws',
  hostId: 'local',
  agent: 'claude' as const,
  providerHandle: claudeProviderHandle('provider-session', null)
}
let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pr37966-mail-'))
})
afterEach(async () => {
  await tracked.closeAll()
  await closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})
const open = () => tracked.open({ stateDirectory: root, identity, mintEpoch: () => 'epoch-1' })
const body: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'canonical model input' }],
  from: {
    kind: 'agent',
    senders: [
      {
        party: { address: 'orca-bg-wake', terminalHandle: 'orca-bg-wake', orcaSessionId: null },
        name: null
      }
    ],
    orchestration: {
      message: 'mail-notice',
      mailbox: 'run:receiver',
      dispatchId: null,
      messages: [{ messageId: 'mail-1', runId: 'run-1', from: 'orca-bg-wake' }]
    }
  }
}
const fact = {
  mailbox: 'run:receiver',
  messageId: 'mail-1',
  runId: 'run-1',
  from: 'orca-bg-wake',
  report: {
    version: 1 as const,
    kind: 'command' as const,
    result: { type: 'exit' as const, code: 0 }
  }
}

it('commits the report with the actual queued row, retains it through handoff and restart, and leaves canonical input unchanged', async () => {
  const journal = await open()
  const saved = JSON.stringify(body)
  await journal.queuedMessages.insert(
    { messageId: 'q-1', body },
    journal.mailDisplayReports.receipt(body, [fact])
  )
  expect(journal.mailDisplayReports.project([{ itemId: 'queued', body }])?.entries).toEqual([
    { ...fact, itemId: 'queued' }
  ])
  await journal.appendSubmission(
    {
      clientMessageId: 'handoff',
      body,
      fence: 0,
      handoverRecorded: true,
      origin: 'host',
      payloadFingerprint: journal.queuedMessages.get('q-1')!.fingerprint
    },
    { messageId: 'q-1', expect: 'waiting' }
  )
  await journal.close()
  const reopened = await open()
  const projected = reopened.mailDisplayReports.project([{ itemId: 'received', body }])
  expect(projected?.entries).toEqual([{ ...fact, itemId: 'received' }])
  expect(JSON.stringify(body)).toBe(saved)
  expect(JSON.stringify(reopened.publicRead())).not.toContain('mailDisplayReports')
  expect(
    reopened.mailDisplayReports.project([
      {
        itemId: 'wrong',
        body: {
          ...body,
          from: {
            ...body.from!,
            orchestration: {
              message: 'mail-notice',
              mailbox: 'other',
              dispatchId: null,
              messages: [{ messageId: 'mail-1', runId: 'run-1', from: 'orca-bg-wake' }]
            }
          }
        }
      }
    ])
  ).toBeUndefined()
})

it('rolls report and card back together and never upgrades a duplicate metadata-free admission', async () => {
  const journal = await open()
  const fail = {
    write: () => {
      throw new Error('rollback')
    },
    committed: () => undefined
  }
  await expect(
    journal.queuedMessages.insert(
      { messageId: 'q-1', body },
      composeJournalOperationReceipts(journal.mailDisplayReports.receipt(body, [fact]), fail)
    )
  ).rejects.toThrow('rollback')
  expect(journal.queuedMessages.get('q-1')).toBeNull()
  expect(
    openTestJournalHostDatabase(root)
      .db.prepare('SELECT COUNT(*) AS n FROM journal_mail_display_reports')
      .get()
  ).toEqual({ n: 0 })
  await journal.queuedMessages.insert({ messageId: 'q-1', body })
  await journal.queuedMessages.insert(
    { messageId: 'q-1', body },
    journal.mailDisplayReports.receipt(body, [fact])
  )
  expect(journal.mailDisplayReports.project([{ itemId: 'q-1', body }])).toBeUndefined()
})

it('salvages malformed optional rows without refusing readable history', async () => {
  const journal = await open()
  await journal.queuedMessages.insert(
    { messageId: 'q-1', body },
    journal.mailDisplayReports.receipt(body, [fact])
  )
  await journal.close()
  openTestJournalHostDatabase(root)
    .db.prepare('UPDATE journal_mail_display_reports SET report_json = ?')
    .run('{bad')
  const reopened = await open()
  expect(reopened.queuedMessages.get('q-1')?.body).toEqual(body)
  expect(reopened.mailDisplayReports.project([{ itemId: 'q-1', body }])).toBeUndefined()
})

it('drains already admitted canonical mail and its report before closing the owner', async () => {
  const journal = await open()
  let admitted: Promise<unknown> | undefined
  let closing: Promise<void> | undefined
  await journal.queuedMessages.insert(
    {
      messageId: 'outer',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Other input' }] }
    },
    {
      write: () => {
        admitted = journal.queuedMessages.insert(
          { messageId: 'q-1', body },
          journal.mailDisplayReports.receipt(body, [fact])
        )
        closing = journal.close()
      },
      committed: () => undefined
    }
  )
  await admitted
  await closing
  const reopened = await open()
  expect(reopened.queuedMessages.get('q-1')?.body).toEqual(body)
  expect(reopened.mailDisplayReports.project([{ itemId: 'q-1', body }])?.entries).toEqual([
    { ...fact, itemId: 'q-1' }
  ])
})

it.each([100, 1000])(
  'retires only touched mail owners with %i unrelated retained messages',
  async (count) => {
    const journal = await open()
    const ordinary: AgentJournalMessageItem = {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'Unrelated retained history' }]
    }
    for (let i = 0; i < count; i++) {
      await journal.appendItem(
        { provider: 'claude', sessionId: 'provider-session', uuid: `ordinary-${i}` },
        ordinary,
        { fence: 0, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
    }
    await journal.queuedMessages.insert(
      { messageId: 'q-1', body },
      journal.mailDisplayReports.receipt(body, [fact])
    )
    const kept = { provider: 'claude' as const, sessionId: 'provider-session', uuid: 'kept-report' }
    await journal.appendItem(kept, body, { fence: 0, turnScope: AGENT_JOURNAL_THREAD_SCOPE })
    const published = readPublishedQueuedMessages(journal)
    expect(published[0]?.mailDisplayReports).toMatchObject([fact])
    const project = vi.spyOn(journal.mailDisplayReports, 'project')
    for (let i = 0; i < 100; i++) {
      expect(readPublishedQueuedMessages(journal)).toBe(published)
    }
    expect(project).not.toHaveBeenCalled()
    project.mockRestore()
    const read = vi.spyOn(sourceFacts, 'orchestrationMailNotice')
    try {
      const response = { item: { itemId: 'kept', body } }
      const enriched = withMailDisplayReports(journal, response, [response.item], 16384)
      expect(enriched).toMatchObject({ mailDisplayReports: { entries: [fact] } })
      expect(read.mock.calls.length).toBe(1)
      const canonicalOnly = withMailDisplayReports(
        journal,
        response,
        [response.item],
        Buffer.byteLength(JSON.stringify(response))
      )
      expect(canonicalOnly).toBe(response)
      expect(response).not.toHaveProperty('mailDisplayReports')
      read.mockClear()
      await journal.queuedMessages.withdraw(['q-1'])
      expect(read.mock.calls.length).toBeLessThanOrEqual(12)
      expect(journal.mailDisplayReports.project([{ itemId: 'kept', body }])?.entries).toHaveLength(
        1
      )
      await journal.appendTombstone(kept, { fence: 0 })
      expect(journal.mailDisplayReports.project([{ itemId: 'kept', body }])).toBeUndefined()
      expect(
        openTestJournalHostDatabase(root)
          .db.prepare('SELECT COUNT(*) AS n FROM journal_mail_display_reports')
          .get()
      ).toEqual({ n: 0 })
    } finally {
      read.mockRestore()
    }
  }
)

it.each(['database-newer', 'format-newer', 'damaged'] as const)(
  'never prunes display facts when the existing open gate refuses %s state',
  async (kind) => {
    const journal = await open()
    await journal.queuedMessages.insert(
      { messageId: 'q-1', body },
      journal.mailDisplayReports.receipt(body, [fact])
    )
    await journal.close()
    const database = openTestJournalHostDatabase(root)
    // An unowned fact makes any accidental pruning observable.
    database.db
      .prepare('UPDATE journal_mail_display_reports SET mail_message_id = ?')
      .run('unowned')
    const before = database.db.prepare('SELECT * FROM journal_mail_display_reports').all()
    if (kind === 'database-newer') {
      database.db.pragma('user_version = 999')
    } else if (kind === 'format-newer') {
      database.db.prepare('UPDATE journal_outcome_epochs SET format = 99').run()
    } else {
      database.db
        .prepare("UPDATE journal_outcomes SET value_json = '{bad' WHERE field = 'queue.cards'")
        .run()
    }
    if (kind === 'database-newer') {
      await closeTestJournalHostDatabase(root)
    }
    await expect(open()).rejects.toThrow()
    expect(
      openTestJournalHostDatabase(root)
        .db.prepare('SELECT * FROM journal_mail_display_reports')
        .all()
    ).toEqual(before)
  }
)

it('accepts direct input and display atomically and retains the fact with its input across epoch replacement', async () => {
  const journal = await open()
  const submission = {
    clientMessageId: 'direct',
    body,
    fence: 0,
    handoverRecorded: true as const,
    origin: 'host' as const,
    payloadFingerprint: 'canonical'
  }
  const fail = {
    write: () => {
      throw new Error('direct rollback')
    },
    committed: () => undefined
  }
  await expect(
    journal.appendSubmission(
      submission,
      undefined,
      composeJournalOperationReceipts(journal.mailDisplayReports.receipt(body, [fact]), fail)
    )
  ).rejects.toThrow('direct rollback')
  expect(journal.submission('direct')).toBeUndefined()
  expect(journal.mailDisplayReports.project([{ itemId: 'direct', body }])).toBeUndefined()
  await journal.appendSubmission(
    submission,
    undefined,
    journal.mailDisplayReports.receipt(body, [fact])
  )
  expect(journal.mailDisplayReports.project([{ itemId: 'direct', body }])?.entries).toHaveLength(1)
  await journal.replaceEpochItems('unreconcilable_prefix', 0, [])
  expect(journal.mailDisplayReports.project([{ itemId: 'direct', body }])?.entries).toHaveLength(1)
})
