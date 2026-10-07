// Draft bookkeeping never vetoes a journal row: a failing draft transition
// rolls back alone and the next open re-derives it, and a draft table an
// earlier build created gains the columns this build writes.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import Database from '../../sqlite/sync-database'
import { journalDatabasePath } from './journal-host-database'
import { JournalQueuedMessages } from './journal-queued-messages'
import type { AgentSessionJournal } from './journal-store'
import {
  closeTestJournalHostDatabases,
  createTrackedJournalOpener
} from './journal-host-database-test-support'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-q',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'claude',
  providerHandle: claudeProviderHandle('native-1', null)
}
const REFUSAL = agentSessionFailureWords(
  agentSessionFailureFact('providerRejected', {
    detail: { text: 'Claude refused this payload', audience: 'person' }
  }),
  { surface: 'rejection' }
)

const BODY: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'queued text' }]
}

let root: string
let clock = 1_000
const journals = createTrackedJournalOpener()

function open(): Promise<AgentSessionJournal> {
  return journals.open({
    identity: IDENTITY,
    stateDirectory: root,
    now: () => ++clock,
    mintEpoch: () => `epoch-${clock}`
  })
}

async function queueAndConsume(journal: AgentSessionJournal, messageId: string): Promise<void> {
  const body: AgentJournalMessageItem = {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'queued text' }]
  }
  await journal.queuedMessages.insert({
    messageId,
    body,
    fingerprint: `fp-${messageId}`,
    hostInstance: 'proc-1'
  })
  await journal.appendSubmission(
    {
      clientMessageId: `sub-${messageId}`,
      payloadFingerprint: `fp-${messageId}`,
      body,
      fence: 0,
      handoverRecorded: true
    },
    { messageId, expect: 'waiting', settledByOp: null }
  )
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-queued-bookkeeping-'))
  clock = 1_000
})

afterEach(async () => {
  vi.restoreAllMocks()
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('draft bookkeeping inside a journal append', () => {
  it('a throwing draft transition still commits the rejection row, and the next open recovers the draft', async () => {
    let journal = await open()
    await queueAndConsume(journal, 'draft-1')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(JournalQueuedMessages.prototype, 'onRowInTransaction').mockImplementationOnce(() => {
      throw new Error('table queued_messages has no column named returned_rejection')
    })
    await journal.resolveDispatch({
      clientMessageId: 'sub-draft-1',
      state: 'rejected',
      ...REFUSAL,
      fence: 0
    })
    // The journal's own answer stands: Stop, failed starts and refusals depend on it.
    expect(journal.submission('sub-draft-1')?.dispatchState).toBe('rejected')
    expect(journal.queuedMessages.get('draft-1')?.state).toBe('dispatched')
    expect(warn).toHaveBeenCalledWith(
      '[journal-append] row bookkeeping skipped:',
      expect.objectContaining({ kind: 'dispatch' })
    )
    await journal.close()
    journal = await open()
    expect(journal.submission('sub-draft-1')?.dispatchState).toBe('rejected')
    expect(journal.queuedMessages.get('draft-1')).toMatchObject({
      state: 'returned',
      returnedReason: REFUSAL.reason,
      returnedRejection: { kind: 'providerRejected' }
    })
  })

  it('an older draft table without a later column is healed at open, so a refusal returns the card', async () => {
    const first = await open()
    await first.close()
    // The table is healed when the host opens its database, so the host restarts around the edit.
    closeTestJournalHostDatabases()
    const db = new Database(journalDatabasePath(root))
    db.exec('DROP TABLE queued_messages')
    // The shape an earlier build of the draft table wrote: no returned_rejection.
    db.exec(`CREATE TABLE queued_messages (
      session_id TEXT NOT NULL, message_id TEXT NOT NULL, position INTEGER NOT NULL,
      body_json TEXT NOT NULL, fingerprint TEXT NOT NULL, created_at INTEGER NOT NULL,
      host_instance TEXT NOT NULL, state TEXT NOT NULL, hold_reason TEXT,
      returned_reason TEXT, settled_at INTEGER, settled_by_op TEXT, consumed_as TEXT,
      PRIMARY KEY (session_id, message_id))`)
    db.close()
    const journal = await open()
    await queueAndConsume(journal, 'draft-1')
    await journal.resolveDispatch({
      clientMessageId: 'sub-draft-1',
      state: 'rejected',
      ...REFUSAL,
      fence: 0
    })
    expect(journal.queuedMessages.get('draft-1')).toMatchObject({
      state: 'returned',
      returnedRejection: { kind: 'providerRejected' }
    })
  })

  describe('a failed COMMIT', () => {
    /** The append's own COMMIT fails once, after its hooks ran. */
    function failNextCommit() {
      const exec = Database.prototype.exec
      let armed = true
      return vi.spyOn(Database.prototype, 'exec').mockImplementation(function (
        this: Database,
        sql: string
      ) {
        if (armed && sql === 'COMMIT') {
          armed = false
          throw new Error('SQLITE_FULL')
        }
        return exec.call(this, sql)
      })
    }

    async function consumeFailingCommit(journal: AgentSessionJournal): Promise<void> {
      await journal.queuedMessages.insert({
        messageId: 'draft-1',
        body: BODY,
        fingerprint: 'fp-draft-1',
        hostInstance: 'proc-1'
      })
      expect(journal.queuedMessages.list()).toMatchObject([{ state: 'waiting' }])
      const commit = failNextCommit()
      try {
        await expect(
          journal.appendSubmission(
            { clientMessageId: 'sub-draft-1', payloadFingerprint: 'fp', body: BODY, fence: 0 },
            { messageId: 'draft-1', expect: 'waiting', settledByOp: null }
          )
        ).rejects.toThrow('SQLITE_FULL')
      } finally {
        commit.mockRestore()
      }
    }

    it('leaves no uncommitted draft state cached: the per-row hook reads drafts only for an echo', async () => {
      const journal = await open()
      const list = vi.spyOn(JournalQueuedMessages.prototype, 'list')
      await consumeFailingCommit(journal)
      // Once by the test itself before the append; never inside it.
      expect(list).toHaveBeenCalledTimes(1)
      list.mockRestore()
      expect(journal.submissions()).toHaveLength(0)
      expect(journal.queuedMessages.list()).toMatchObject([
        { messageId: 'draft-1', state: 'waiting' }
      ])
    })

    it('invalidates what any read inside the rolled-back transaction cached', async () => {
      const journal = await open()
      // Some other bookkeeping reads the list inside the transaction, after the consume wrote.
      vi.spyOn(JournalQueuedMessages.prototype, 'onRowInTransaction').mockImplementation(function (
        this: JournalQueuedMessages
      ) {
        this.list()
      })
      await consumeFailingCommit(journal)
      expect(journal.queuedMessages.list()).toMatchObject([
        { messageId: 'draft-1', state: 'waiting' }
      ])
    })
  })
})
