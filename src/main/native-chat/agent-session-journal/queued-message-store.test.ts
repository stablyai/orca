// The draft store's contract: exactly-once consume in one transaction, the
// rejected-draft settlement following the journal's EFFECTIVE settlement, retention
// that never outruns a slow refusal, and rows that survive epoch replacement.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import type {
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { QUEUED_MESSAGE_PAUSED_KEPT } from '../../../shared/agent-session-queued-message-wire'
import Database from '../../sqlite/sync-database'
import { JOURNAL_DB_SCHEMA_VERSION } from './journal-database-schema'
import { journalDatabasePath } from './journal-host-database'
import {
  JournalQueuedMessages,
  QUEUED_MESSAGE_REPLAY_WINDOW_MS,
  QueuedMessageNotConsumableError
} from './journal-queued-messages'
import type { AgentSessionJournal } from './journal-store'
import type { AgentMessageSource } from '../../../shared/agent-session-message-source'
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

let root: string
let clock = 1_000

function tick(): number {
  clock += 1
  return clock
}

function message(text: string): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
}

const journals = createTrackedJournalOpener()
const STOP_WITHDRAWAL = agentSessionFailureWords(agentSessionFailureFact('cancelled'), {
  surface: 'rejection'
})
const HOST_RESTARTED = agentSessionFailureWords(agentSessionFailureFact('hostRestarted'), {
  surface: 'rejection'
})
const PROVIDER_REFUSAL = agentSessionFailureFact('providerRejected', {
  detail: { text: 'Claude refused this payload', audience: 'person' }
})
/** A provider refusal as a settled rejection stores it: its sentence and typed fact. */
function refusal(text: string) {
  return agentSessionFailureWords(
    agentSessionFailureFact('providerRejected', { detail: { text, audience: 'person' } }),
    { surface: 'rejection' }
  )
}

async function open(): Promise<AgentSessionJournal> {
  const journal = await journals.open({
    identity: IDENTITY,
    stateDirectory: root,
    now: tick,
    mintEpoch: () => `epoch-${clock}`
  })
  return journal
}

async function queueDraft(journal: AgentSessionJournal, messageId: string, text = 'queued text') {
  return journal.queuedMessages.insert({
    messageId,
    body: message(text),
    fingerprint: `fp-${messageId}`,
    hostInstance: 'proc-1'
  })
}

async function consumeDraft(
  journal: AgentSessionJournal,
  messageId: string,
  options: {
    as?: string
    expect?: 'waiting' | 'returned'
    settledByOp?: string | null
    origin?: 'client' | 'host'
  } = {}
) {
  const draft = journal.queuedMessages.get(messageId)
  await journal.appendSubmission(
    {
      clientMessageId: options.as ?? `sub-${messageId}`,
      payloadFingerprint: draft?.fingerprint ?? `fp-${messageId}`,
      body: draft?.body ?? message('queued text'),
      fence: 0,
      handoverRecorded: true,
      ...(options.origin ? { origin: options.origin } : {})
    },
    {
      messageId,
      expect: options.expect ?? 'waiting',
      settledByOp: options.settledByOp ?? null
    }
  )
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-queued-message-'))
  clock = 1_000
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('draft rows', () => {
  it('creates the table at open without bumping user_version, so an old build stays writable', async () => {
    const journal = await open()
    await queueDraft(journal, 'draft-1')
    await journal.close()
    const db = new Database(journalDatabasePath(root), { readonly: true })
    try {
      const version = Number(db.pragma('user_version', { simple: true }))
      // An old build compares stored == supported and keeps writing; a bump
      // would cost it every chat after a downgrade.
      expect(version).toBe(JOURNAL_DB_SCHEMA_VERSION)
      const table = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get('queued_messages')
      expect(table).toBeDefined()
    } finally {
      db.close()
    }
  })

  it('opens a database an older build shaped (no drafts table) and creates the table', async () => {
    const first = await open()
    await first.appendItem(
      { provider: 'orca', clientMessageId: 'seed' },
      { kind: 'status', text: 'seed' },
      { fence: 0, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await first.close()
    // The table is created when the host opens its database, so the host restarts around the edit.
    closeTestJournalHostDatabases()
    const db = new Database(journalDatabasePath(root))
    db.exec('DROP TABLE queued_messages')
    db.close()
    const journal = await open()
    const row = await queueDraft(journal, 'draft-1')
    expect(row.position).toBe(1)
  })

  it('assigns monotonic positions and lists in order', async () => {
    const journal = await open()
    await queueDraft(journal, 'draft-1')
    await queueDraft(journal, 'draft-2')
    const listed = journal.queuedMessages.list()
    expect(listed.map((row) => [row.messageId, row.position, row.state])).toEqual([
      ['draft-1', 1, 'waiting'],
      ['draft-2', 2, 'waiting']
    ])
  })

  it('replays an insert under an already-used id instead of duplicating', async () => {
    const journal = await open()
    await queueDraft(journal, 'draft-1')
    const again = await queueDraft(journal, 'draft-1')
    expect(again.position).toBe(1)
    expect(journal.queuedMessages.list()).toHaveLength(1)
  })

  it("keeps an agent card's body as written across reopen: the queue reads nothing of its sender", async () => {
    const from: AgentMessageSource = {
      kind: 'agent',
      senders: [
        {
          party: {
            address: 'structworker_1',
            terminalHandle: 'structworker_1',
            orcaSessionId: null
          },
          name: 'Reviewer'
        }
      ],
      orchestration: {
        message: 'mail-notice',
        mailbox: 'run:r1',
        dispatchId: 'd1',
        messages: [{ messageId: 'm1', runId: 'r1', from: 'structworker_1' }]
      }
    }
    const first = await open()
    const insert = (messageId: string, body: AgentJournalMessageItem) =>
      first.queuedMessages.insert({
        messageId,
        body,
        fingerprint: `fp-${messageId}`,
        hostInstance: 'proc-1'
      })
    await insert('agent-card', { ...message('You have 1 orchestration message.'), from })
    await insert('newer-kind', {
      ...message('a task'),
      from: { ...from, orchestration: null }
    })
    await insert('malformed', message('typed'))
    await first.close()
    closeTestJournalHostDatabases()
    const db = new Database(journalDatabasePath(root))
    // A newer build's message kind, and a value no build writes: carried as written, for clients to read.
    const setFrom = db.prepare(
      "UPDATE queued_messages SET body_json = json_set(body_json, '$.from', json(?)) WHERE message_id = ?"
    )
    setFrom.run(
      JSON.stringify({ ...from, orchestration: { message: 'task', taskId: 't1' } }),
      'newer-kind'
    )
    setFrom.run(JSON.stringify('nobody'), 'malformed')
    // A table from a build that also kept the sender in a column of its own.
    db.exec('ALTER TABLE queued_messages ADD COLUMN source_json TEXT')
    db.close()
    const reopened = await open()
    expect(reopened.queuedMessages.list().map((row) => [row.messageId, row.body.from])).toEqual([
      ['agent-card', from],
      ['newer-kind', { ...from, orchestration: { message: 'task', taskId: 't1' } }],
      ['malformed', 'nobody']
    ])
    // That older table still takes new cards.
    await queueDraft(reopened, 'after')
    expect(reopened.queuedMessages.list()).toHaveLength(4)
  })

  it('drafts survive epoch replacement, which deletes only journal rows', async () => {
    const journal = await open()
    await queueDraft(journal, 'draft-1')
    await journal.replaceEpochItems('handle_forked', 0, [])
    expect(journal.queuedMessages.list().map((row) => row.messageId)).toEqual(['draft-1'])
  })
})

describe('consume', () => {
  it('converts waiting → dispatched and appends the submission in one transaction', async () => {
    const journal = await open()
    await queueDraft(journal, 'draft-1')
    await consumeDraft(journal, 'draft-1')
    const row = journal.queuedMessages.get('draft-1')
    expect(row?.state).toBe('dispatched')
    expect(row?.consumedAs).toBe('sub-draft-1')
    expect(journal.submissions().map((entry) => entry.clientMessageId)).toEqual(['sub-draft-1'])
  })

  it('never hands a draft off under its own id: the submission names it by link, not id equality', async () => {
    const journal = await open()
    await queueDraft(journal, 'draft-1')
    await expect(consumeDraft(journal, 'draft-1', { as: 'draft-1' })).rejects.toBeInstanceOf(
      QueuedMessageNotConsumableError
    )
    expect(journal.submissions()).toHaveLength(0)
    expect(journal.queuedMessages.get('draft-1')?.state).toBe('waiting')
  })

  it('never records a second submission under an id it already holds, whatever state it settled in', async () => {
    const journal = await open()
    await queueDraft(journal, 'draft-1')
    await consumeDraft(journal, 'draft-1')
    await journal.resolveDispatch({
      clientMessageId: 'sub-draft-1',
      state: 'rejected',
      ...refusal('refused'),
      fence: 0
    })
    const cursor = journal.cursor()
    await expect(
      journal.appendSubmission({
        clientMessageId: 'sub-draft-1',
        payloadFingerprint: 'fp-draft-1',
        body: message('queued text'),
        fence: 0,
        handoverRecorded: true
      })
    ).rejects.toMatchObject({ code: 'journal_submission_exists' })
    // The refusal stands: re-appending would reset it to pending and hand it over again.
    expect(journal.submission('sub-draft-1')?.dispatchState).toBe('rejected')
    expect(journal.cursor()).toEqual(cursor)
  })

  it('a second consume of the same draft fails and appends nothing (exactly-once)', async () => {
    const journal = await open()
    await queueDraft(journal, 'draft-1')
    await consumeDraft(journal, 'draft-1')
    await expect(consumeDraft(journal, 'draft-1', { as: 'second-id' })).rejects.toBeInstanceOf(
      QueuedMessageNotConsumableError
    )
    expect(journal.submissions().map((entry) => entry.clientMessageId)).toEqual(['sub-draft-1'])
  })

  it('a consume racing a withdraw loses and appends nothing', async () => {
    const journal = await open()
    await queueDraft(journal, 'draft-1')
    await journal.queuedMessages.withdraw({
      messageIds: ['draft-1'],
      settledByOp: 'caller\u0000op-1'
    })
    await expect(consumeDraft(journal, 'draft-1')).rejects.toBeInstanceOf(
      QueuedMessageNotConsumableError
    )
    expect(journal.submissions()).toHaveLength(0)
    expect(journal.queuedMessages.get('draft-1')?.state).toBe('withdrawn')
  })

  it('a failed submission insert rolls the draft transition back', async () => {
    const journal = await open()
    await queueDraft(journal, 'draft-1')
    const cursor = journal.cursor()
    // Occupy the next sequence directly so the append's INSERT violates the
    // primary key inside the transaction, after the draft was transitioned.
    const db = new Database(journalDatabasePath(root))
    db.prepare(
      'INSERT INTO journal_rows (session_id, epoch, seq, ts, row_json) VALUES (?, ?, ?, ?, ?)'
    ).run(IDENTITY.sessionId, cursor.epoch, cursor.sequence + 1, tick(), '{}')
    db.close()
    await expect(consumeDraft(journal, 'draft-1')).rejects.toThrow()
    expect(journal.queuedMessages.get('draft-1')?.state).toBe('waiting')
  })
})

describe('returned transition (D1/N4)', () => {
  it('a non-withdrawn rejection returns the consumed draft with its reason', async () => {
    const journal = await open()
    await queueDraft(journal, 'draft-1')
    await consumeDraft(journal, 'draft-1')
    await journal.resolveDispatch({
      clientMessageId: 'sub-draft-1',
      state: 'rejected',
      ...refusal('Claude refused this payload'),
      rejection: PROVIDER_REFUSAL,
      fence: 0
    })
    const row = journal.queuedMessages.get('draft-1')
    expect(row?.state).toBe('returned')
    expect(row?.returnedReason).toBe(refusal('Claude refused this payload').reason)
    expect(row?.returnedRejection).toEqual(PROVIDER_REFUSAL)
  })

  it('a late rejection row after acceptance settles nothing and returns no card', async () => {
    const journal = await open()
    await queueDraft(journal, 'draft-1')
    await consumeDraft(journal, 'draft-1')
    await journal.resolveDispatch({
      clientMessageId: 'sub-draft-1',
      state: 'accepted',
      providerIdentity: { provider: 'claude', sessionId: 'native-1', uuid: 'echo-1' },
      fence: 0
    })
    await journal.resolveDispatch({
      clientMessageId: 'sub-draft-1',
      state: 'rejected',
      ...refusal('late duplicate'),
      fence: 0
    })
    expect(journal.queuedMessages.get('draft-1')?.state).toBe('dispatched')
  })

  it("a Stop's withdrawal before the agent received it sends the draft back to waiting, held like the rest, and it survives a restart", async () => {
    let journal = await open()
    await queueDraft(journal, 'draft-1')
    await consumeDraft(journal, 'draft-1')
    // The Stop's own withdrawal path: the queued (not handed over) submission.
    expect(await journal.rejectQueuedSubmissions(0, STOP_WITHDRAWAL)).toEqual(['sub-draft-1'])
    // Nothing failed: no refusal to show, its position kept, its spent id recorded.
    const requeued = {
      state: 'waiting',
      position: 1,
      holdReason: null,
      consumedAs: null,
      returnedReason: null,
      returnedRejection: null
    }
    expect(journal.queuedMessages.get('draft-1')).toMatchObject(requeued)
    // Atomic with the rejection row: a crash before the Stop answered keeps the text.
    await journal.close()
    clock += QUEUED_MESSAGE_REPLAY_WINDOW_MS + 1_000
    journal = await open()
    expect(journal.queuedMessages.get('draft-1')).toMatchObject(requeued)
  })

  it('a draft sent back to waiting hands off again under a fresh id, never a spent one', async () => {
    const journal = await open()
    await queueDraft(journal, 'draft-1')
    await consumeDraft(journal, 'draft-1')
    await journal.rejectQueuedSubmissions(0, STOP_WITHDRAWAL)
    // The spent id already names a rejected submission: one id, one delivery.
    await expect(consumeDraft(journal, 'draft-1')).rejects.toMatchObject({
      code: 'journal_submission_exists'
    })
    expect(journal.submission('sub-draft-1')?.dispatchState).toBe('rejected')
    await consumeDraft(journal, 'draft-1', { as: 'fresh-1' })
    expect(journal.queuedMessages.get('draft-1')).toMatchObject({
      state: 'dispatched',
      consumedAs: 'fresh-1'
    })
    // Both hand-offs name the draft.
    expect(journal.submission('fresh-1')).toMatchObject({
      dispatchState: 'pending',
      queuedMessageId: 'draft-1'
    })
    expect(journal.submission('sub-draft-1')?.queuedMessageId).toBe('draft-1')
  })

  it.each([
    { by: 'the queue', origin: 'host' as const, holdReason: null },
    { by: 'the person', origin: 'client' as const, holdReason: QUEUED_MESSAGE_PAUSED_KEPT }
  ])(
    'a restart between $by’s consume and handover sends the draft back to waiting',
    async ({ origin, holdReason }) => {
      let journal = await open()
      await queueDraft(journal, 'draft-1')
      await consumeDraft(journal, 'draft-1', { origin })
      await journal.close()
      journal = await open()
      expect(journal.queuedMessages.get('draft-1')?.state).toBe('dispatched')
      await journal.rejectQueuedSubmissions(0, HOST_RESTARTED, (submission) =>
        journal.wroteBeforeOpen(submission.acceptedSequence)
      )
      // The queue's own hand-off waits under the restart's pause, derived from the row's host
      // instance; a Send the person asked for waits for them, kept.
      expect(journal.queuedMessages.get('draft-1')).toMatchObject({
        state: 'waiting',
        holdReason,
        hostInstance: 'proc-1',
        consumedAs: null,
        returnedReason: null
      })
    }
  )

  it('refuse → Send under a fresh id → refuse again returns the card again; a late duplicate of the first refusal never touches the re-send (N4)', async () => {
    const journal = await open()
    await queueDraft(journal, 'draft-1')
    await consumeDraft(journal, 'draft-1')
    await journal.resolveDispatch({
      clientMessageId: 'sub-draft-1',
      state: 'rejected',
      ...refusal('first refusal'),
      rejection: PROVIDER_REFUSAL,
      fence: 0
    })
    expect(journal.queuedMessages.get('draft-1')?.state).toBe('returned')
    // Send on the returned card re-consumes under a fresh submission id.
    await consumeDraft(journal, 'draft-1', { as: 'resend-1', expect: 'returned' })
    // The earlier refusal retires with the card: the row now describes the re-send.
    expect(journal.queuedMessages.get('draft-1')).toMatchObject({
      state: 'dispatched',
      consumedAs: 'resend-1',
      returnedReason: null,
      returnedRejection: null
    })
    // A duplicate resolution of the FIRST submission is ignored by the journal
    // and must not alter the draft's current relation.
    await journal.resolveDispatch({
      clientMessageId: 'sub-draft-1',
      state: 'rejected',
      ...refusal('duplicate of first refusal'),
      fence: 0
    })
    expect(journal.queuedMessages.get('draft-1')?.state).toBe('dispatched')
    // The re-send's own refusal returns the card, matched via consumed_as.
    await journal.resolveDispatch({
      clientMessageId: 'resend-1',
      state: 'rejected',
      ...refusal('second refusal'),
      fence: 0
    })
    const returned = journal.queuedMessages.get('draft-1')
    expect(returned?.state).toBe('returned')
    expect(returned?.returnedReason).toBe(refusal('second refusal').reason)
    // The first refusal's fact does not outlive it: the pair is the second submission's.
    expect(returned?.returnedRejection).toEqual(refusal('second refusal').rejection)
    expect(returned?.returnedRejection).not.toEqual(PROVIDER_REFUSAL)
  })

  it('a rejection never revives a withdrawn draft', async () => {
    const journal = await open()
    await queueDraft(journal, 'draft-1')
    await consumeDraft(journal, 'draft-1')
    await journal.resolveDispatch({
      clientMessageId: 'sub-draft-1',
      state: 'rejected',
      ...refusal('refused'),
      fence: 0
    })
    await journal.queuedMessages.withdraw({ messageIds: ['draft-1'], settledByOp: 'c\u0000op' })
    expect(journal.queuedMessages.get('draft-1')?.state).toBe('withdrawn')
    await journal.resolveDispatch({
      clientMessageId: 'sub-draft-1',
      state: 'rejected',
      ...refusal('again'),
      fence: 0
    })
    expect(journal.queuedMessages.get('draft-1')?.state).toBe('withdrawn')
  })

  it('the returned row and its stored reason survive epoch replacement and reopen (B1)', async () => {
    let journal = await open()
    await queueDraft(journal, 'draft-1')
    await consumeDraft(journal, 'draft-1')
    await journal.resolveDispatch({
      clientMessageId: 'sub-draft-1',
      state: 'rejected',
      ...refusal('stored refusal'),
      fence: 0
    })
    await journal.replaceEpochItems('handle_forked', 0, [])
    await journal.close()
    journal = await open()
    const row = journal.queuedMessages.get('draft-1')
    expect(row?.state).toBe('returned')
    expect(row?.returnedReason).toBe(refusal('stored refusal').reason)
  })
})

describe('withdraw', () => {
  it('withdraws waiting and returned rows together into op-stamped receipts', async () => {
    const journal = await open()
    await queueDraft(journal, 'draft-1', 'first text')
    await queueDraft(journal, 'draft-2', 'second text')
    await consumeDraft(journal, 'draft-1')
    await journal.resolveDispatch({
      clientMessageId: 'sub-draft-1',
      state: 'rejected',
      ...refusal('refused'),
      fence: 0
    })
    const withdrawn = await journal.queuedMessages.withdraw({
      messageIds: ['draft-1', 'draft-2'],
      settledByOp: 'caller\u0000stop-1'
    })
    expect(withdrawn.map((row) => [row.messageId, row.body.blocks])).toEqual([
      ['draft-1', [{ type: 'text', text: 'first text' }]],
      ['draft-2', [{ type: 'text', text: 'second text' }]]
    ])
    // A lost acknowledgement replays from the tombstones, keyed by the
    // caller-scoped operation key — never from the ledger.
    const receipts = journal.queuedMessages.receipts('caller\u0000stop-1')
    expect(receipts.map((row) => row.messageId)).toEqual(['draft-1', 'draft-2'])
    // Pending or dispatched rows stay outside the withdrawable set.
    const second = await journal.queuedMessages.withdraw({
      messageIds: ['draft-1'],
      settledByOp: 'caller\u0000stop-2'
    })
    expect(second).toHaveLength(0)
  })

  it('two callers reusing one operation id read only their own receipts', async () => {
    const journal = await open()
    await queueDraft(journal, 'draft-1')
    await journal.queuedMessages.withdraw({
      messageIds: ['draft-1'],
      settledByOp: 'caller-a\u0000op-1'
    })
    expect(journal.queuedMessages.receipts('caller-b\u0000op-1')).toHaveLength(0)
    expect(journal.queuedMessages.receipts('caller-a\u0000op-1')).toHaveLength(1)
  })
})

describe('open-time repair and retention', () => {
  it('a failed repair is reported and skipped, never failing the open', async () => {
    const repair = vi
      .spyOn(JournalQueuedMessages.prototype, 'repairAndPrune')
      .mockRejectedValueOnce(new Error('SQLITE_FULL'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const journal = await open()
      expect(warn).toHaveBeenCalledWith(
        '[journal-open] queued-message repair skipped:',
        expect.objectContaining({ error: 'SQLITE_FULL' })
      )
      await queueDraft(journal, 'draft-1')
      expect(journal.queuedMessages.list()).toHaveLength(1)
    } finally {
      repair.mockRestore()
      warn.mockRestore()
    }
  })

  // The repair reaches the live hook's answer from the stored rejection and who asked for it.
  it.each([
    {
      origin: 'client' as const,
      cause: 'hostRestarted' as const,
      holdReason: QUEUED_MESSAGE_PAUSED_KEPT
    },
    { origin: 'host' as const, cause: 'hostRestarted' as const, holdReason: null },
    {
      origin: 'client' as const,
      cause: 'chatClosed' as const,
      holdReason: QUEUED_MESSAGE_PAUSED_KEPT
    },
    { origin: 'host' as const, cause: 'chatClosed' as const, holdReason: null }
  ])(
    'a skipped hook for a $origin hand-off cut short ($cause) is repaired at open, holdReason $holdReason',
    async ({ origin, cause, holdReason }) => {
      let journal = await open()
      await queueDraft(journal, 'draft-1')
      await consumeDraft(journal, 'draft-1', { origin })
      await journal.rejectQueuedSubmissions(
        0,
        agentSessionFailureWords(agentSessionFailureFact(cause), { surface: 'rejection' })
      )
      await journal.close()
      // The hook "was skipped": the draft is back to dispatched behind the stored rejection.
      const db = new Database(journalDatabasePath(root))
      db.prepare(
        "UPDATE queued_messages SET state = 'dispatched', hold_reason = NULL, consumed_as = 'sub-draft-1' WHERE message_id = ?"
      ).run('draft-1')
      db.close()
      journal = await open()
      expect(journal.queuedMessages.get('draft-1')).toMatchObject({
        state: 'waiting',
        holdReason,
        consumedAs: null
      })
    }
  )

  it('returns a dispatched row whose loaded submission is effectively rejected (downgrade wrote no hook)', async () => {
    let journal = await open()
    await queueDraft(journal, 'draft-1')
    await consumeDraft(journal, 'draft-1')
    await journal.resolveDispatch({
      clientMessageId: 'sub-draft-1',
      state: 'rejected',
      ...refusal('refused while downgraded'),
      rejection: PROVIDER_REFUSAL,
      fence: 0
    })
    await journal.close()
    // Simulate the old build having written the rejection with no hook: put the
    // draft back to dispatched behind the stored fact.
    const db = new Database(journalDatabasePath(root))
    db.prepare(
      "UPDATE queued_messages SET state = 'dispatched', returned_reason = NULL, returned_rejection = NULL WHERE message_id = ?"
    ).run('draft-1')
    db.close()
    journal = await open()
    const row = journal.queuedMessages.get('draft-1')
    expect(row?.state).toBe('returned')
    expect(row?.returnedReason).toBe(refusal('refused while downgraded').reason)
    expect(row?.returnedRejection).toEqual(PROVIDER_REFUSAL)
  })

  it('sends back to waiting a dispatched row whose submission a Stop withdrew with no hook, never leaving it dispatched', async () => {
    let journal = await open()
    await queueDraft(journal, 'draft-1')
    await consumeDraft(journal, 'draft-1')
    await journal.rejectQueuedSubmissions(0, STOP_WITHDRAWAL)
    await journal.close()
    const db = new Database(journalDatabasePath(root))
    db.prepare(
      "UPDATE queued_messages SET state = 'dispatched', hold_reason = NULL, consumed_as = 'sub-draft-1' WHERE message_id = ?"
    ).run('draft-1')
    db.close()
    clock += QUEUED_MESSAGE_REPLAY_WINDOW_MS + 1_000
    journal = await open()
    // The same settlement the live hook applies.
    expect(journal.queuedMessages.get('draft-1')).toMatchObject({
      state: 'waiting',
      holdReason: null,
      consumedAs: null,
      returnedReason: null
    })
  })

  it('keeps a dispatched row while its submission is still pending, even past the window, so a late rejection still settles it (N5)', async () => {
    let journal = await open()
    await queueDraft(journal, 'draft-1')
    await consumeDraft(journal, 'draft-1')
    await journal.close()
    // Reopen "25 hours" later: the submission is still queued/pending.
    clock += QUEUED_MESSAGE_REPLAY_WINDOW_MS + 60 * 60 * 1000
    journal = await open()
    expect(journal.queuedMessages.get('draft-1')?.state).toBe('dispatched')
    // The delivery loop's leftover rejection now sends it back to waiting.
    await journal.rejectQueuedSubmissions(0, HOST_RESTARTED)
    expect(journal.queuedMessages.get('draft-1')).toMatchObject({
      state: 'waiting',
      consumedAs: null
    })
  })

  it('prunes accepted and withdrawn rows once the replay window passes, and never waiting or returned rows', async () => {
    let journal = await open()
    await queueDraft(journal, 'accepted-1')
    await consumeDraft(journal, 'accepted-1')
    await journal.resolveDispatch({
      clientMessageId: 'sub-accepted-1',
      state: 'accepted',
      providerIdentity: { provider: 'claude', sessionId: 'native-1', uuid: 'echo-1' },
      fence: 0
    })
    await queueDraft(journal, 'withdrawn-1')
    await journal.queuedMessages.withdraw({
      messageIds: ['withdrawn-1'],
      settledByOp: 'c\u0000op-w'
    })
    await queueDraft(journal, 'waiting-1')
    await queueDraft(journal, 'returned-1')
    await consumeDraft(journal, 'returned-1')
    await journal.resolveDispatch({
      clientMessageId: 'sub-returned-1',
      state: 'rejected',
      ...refusal('refused'),
      fence: 0
    })
    await journal.close()
    clock += QUEUED_MESSAGE_REPLAY_WINDOW_MS + 1_000
    journal = await open()
    expect(journal.queuedMessages.list().map((row) => [row.messageId, row.state])).toEqual([
      ['waiting-1', 'waiting'],
      ['returned-1', 'returned']
    ])
  })

  it('keeps fresh tombstones inside the replay window', async () => {
    let journal = await open()
    await queueDraft(journal, 'withdrawn-1')
    await journal.queuedMessages.withdraw({
      messageIds: ['withdrawn-1'],
      settledByOp: 'c\u0000op-w'
    })
    await journal.close()
    clock += 1_000
    journal = await open()
    expect(journal.queuedMessages.get('withdrawn-1')?.state).toBe('withdrawn')
  })
})

describe('holds', () => {
  it('a hold is stored on the row, survives reopen, and withdraw clears it', async () => {
    let journal = await open()
    await queueDraft(journal, 'draft-1')
    await journal.queuedMessages.hold({ messageIds: ['draft-1'], reason: 'send_failed' })
    expect(journal.queuedMessages.get('draft-1')?.holdReason).toBe('send_failed')
    await journal.close()
    journal = await open()
    expect(journal.queuedMessages.get('draft-1')?.holdReason).toBe('send_failed')
    await journal.queuedMessages.withdraw({ messageIds: ['draft-1'], settledByOp: 'c\u0000op' })
    expect(journal.queuedMessages.get('draft-1')).toMatchObject({
      state: 'withdrawn',
      holdReason: null
    })
  })

  it('consume clears the hold in the same transaction (Send-now overrides it)', async () => {
    const journal = await open()
    await queueDraft(journal, 'draft-1')
    await journal.queuedMessages.hold({ messageIds: ['draft-1'], reason: 'send_failed' })
    await consumeDraft(journal, 'draft-1')
    expect(journal.queuedMessages.get('draft-1')).toMatchObject({
      state: 'dispatched',
      holdReason: null
    })
  })

  it('a withdraw naming no drafts touches nothing — a Delete race with no rows costs no write', async () => {
    const journal = await open()
    await journal.close()
    await expect(
      journal.queuedMessages.withdraw({ messageIds: [], settledByOp: 'c\u0000op' })
    ).resolves.toEqual([])
  })

  it('holds reach only waiting rows', async () => {
    const journal = await open()
    await queueDraft(journal, 'draft-1')
    await consumeDraft(journal, 'draft-1')
    await journal.resolveDispatch({
      clientMessageId: 'sub-draft-1',
      state: 'rejected',
      ...refusal('refused'),
      fence: 0
    })
    await journal.queuedMessages.hold({ messageIds: ['draft-1'], reason: 'send_failed' })
    expect(journal.queuedMessages.get('draft-1')).toMatchObject({
      state: 'returned',
      holdReason: null
    })
  })
})

describe('the commit listener', () => {
  it('draft-table writes fire it exactly when rows changed, so no caller publishes by hand', async () => {
    const journal = await open()
    let commits = 0
    journal.observeCommits(() => {
      commits += 1
    })
    await queueDraft(journal, 'draft-1')
    expect(commits).toBe(1)
    // An idempotent replay changes nothing and stays silent.
    await queueDraft(journal, 'draft-1')
    expect(commits).toBe(1)
    await journal.queuedMessages.hold({ messageIds: ['draft-1'], reason: 'send_failed' })
    expect(commits).toBe(2)
    await journal.queuedMessages.hold({ messageIds: ['draft-1'], reason: 'send_failed' })
    expect(commits).toBe(2)
    await journal.queuedMessages.withdraw({ messageIds: ['draft-1'], settledByOp: 'c\u0000op' })
    expect(commits).toBe(3)
    await journal.queuedMessages.withdraw({ messageIds: ['draft-1'], settledByOp: 'c\u0000op-2' })
    expect(commits).toBe(3)
  })
})
