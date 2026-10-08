// The queue's pause is a pure function of the journal: a Stop and a Resume are rows, an accepted
// turn is a row, and a /clear's carried card names its source. Nothing is stored beside
// them, so nothing has to retire.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import Database from '../../sqlite/sync-database'
import { journalDatabasePath } from './journal-host-database'
import {
  createTrackedJournalOpener,
  liveTestJournalRows,
  updateTestJournalRowJson
} from './journal-host-database-test-support'
import { QueuedMessageNotConsumableError } from './journal-queued-messages'
import { applyJournalRow, createJournalReducerState } from './journal-reducer'
import { parseJournalRow } from './journal-row-schema'
import type { AgentSessionJournal } from './journal-store'
import {
  deriveQueuePauses,
  nextSendableQueuedCard,
  queuePauseHolding,
  resumableQueuePause
} from './queued-message-pause'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-p',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'claude',
  providerHandle: claudeProviderHandle('native-1', null)
}
const HOST = 'proc-1'

let root: string
let clock = 1_000
const journals = createTrackedJournalOpener()

function message(text: string): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
}

function open(): Promise<AgentSessionJournal> {
  return journals.open({
    identity: IDENTITY,
    stateDirectory: root,
    now: () => ++clock,
    mintEpoch: () => `epoch-${clock}`
  })
}

function queueDraft(journal: AgentSessionJournal, messageId: string, carriedFrom?: string) {
  return journal.queuedMessages.insert({
    messageId,
    body: message(messageId),
    fingerprint: `fp-${messageId}`,
    hostInstance: HOST,
    ...(carriedFrom ? { carriedFrom } : {})
  })
}

/** A turn sent, then accepted by the provider. */
async function turn(journal: AgentSessionJournal, id: string, accept = true): Promise<void> {
  await journal.appendSubmission({
    clientMessageId: id,
    payloadFingerprint: `fp-${id}`,
    body: message(id),
    fence: 0,
    handoverRecorded: true
  })
  if (accept) {
    await acceptTurn(journal, id)
  }
}

function acceptTurn(journal: AgentSessionJournal, id: string) {
  return journal.resolveDispatch({
    clientMessageId: id,
    state: 'accepted',
    providerIdentity: { provider: 'claude', sessionId: 'native-1', uuid: `echo-${id}` },
    fence: 0
  })
}

/** A person's Stop taking effect. */
function userStop(journal: AgentSessionJournal) {
  return journal.appendStopEvent({ reason: 'user-stop' }, 0)
}

function reason(journal: AgentSessionJournal): string | null {
  return journal.queuedMessages.pauses()[0]?.reason ?? null
}

/** Each card, and whether a pause in force holds it. */
function held(journal: AgentSessionJournal): [string, boolean][] {
  const pauses = journal.queuedMessages.pauses()
  return journal.queuedMessages
    .list()
    .filter((card) => card.state === 'waiting')
    .map((card) => [card.messageId, queuePauseHolding(pauses, card) !== undefined])
}

/** The Stop events stored in the live epoch, oldest first. */
function stopEvents(): unknown[] {
  const db = new Database(journalDatabasePath(root), { readonly: true })
  try {
    return liveTestJournalRows(db, IDENTITY.sessionId).flatMap((stored) => {
      const parsed = parseJournalRow(stored.rowJson)
      return parsed.ok && parsed.row.kind === 'tombstone' && parsed.row.stopEvent
        ? [parsed.row.stopEvent]
        : []
    })
  } finally {
    db.close()
  }
}

/** Rewrites one key of each row at a sequence, as a corrupt write would leave it. */
function rewriteRows(keys: Record<number, [string, unknown]>): void {
  const db = new Database(journalDatabasePath(root))
  try {
    for (const stored of liveTestJournalRows(db, IDENTITY.sessionId)) {
      const rewrite = keys[stored.seq]
      if (rewrite) {
        const row: Record<string, unknown> = JSON.parse(stored.rowJson)
        row[rewrite[0]] = rewrite[1]
        updateTestJournalRowJson(db, IDENTITY.sessionId, stored.seq, JSON.stringify(row))
      }
    }
  } finally {
    db.close()
  }
}

/** Tables that could store a pause: none, the journal rows are the only record. */
function pauseTables(): number {
  const db = new Database(journalDatabasePath(root), { readonly: true })
  try {
    return db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%pause%'")
      .all().length
  } finally {
    db.close()
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-queue-pause-'))
  clock = 1_000
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe("the queue's pause, derived from the journal", () => {
  it("a person's Stop event pauses the queue, even with no card yet, survives reopen, and stores nothing", async () => {
    let journal = await open()
    await userStop(journal)
    expect(reason(journal)).toBe('stopped')
    await queueDraft(journal, 'draft-1')
    await journal.close()
    journal = await open()
    expect(reason(journal)).toBe('stopped')
    expect(pauseTables()).toBe(0)
  })

  it("any turn sent after the Stop and accepted lifts it, Orca's own mail included", async () => {
    const journal = await open()
    await turn(journal, 'before-stop', false)
    await userStop(journal)
    // Sent before the Stop: its acceptance now does not end a Stop that came after it.
    await acceptTurn(journal, 'before-stop')
    expect(reason(journal)).toBe('stopped')
    // Orchestration mail: sent, not yet accepted, lifts nothing; accepted, it lifts the pause.
    await turn(journal, 'mail', false)
    expect(reason(journal)).toBe('stopped')
    await acceptTurn(journal, 'mail')
    expect(reason(journal)).toBeNull()
  })

  it('a later Stop is the latest, and a Resume row lifts it', async () => {
    const journal = await open()
    await userStop(journal)
    await turn(journal, 'typed')
    expect(reason(journal)).toBeNull()
    await userStop(journal)
    expect(reason(journal)).toBe('stopped')
    await journal.appendQueueResume(0)
    expect(reason(journal)).toBeNull()
    await userStop(journal)
    expect(reason(journal)).toBe('stopped')
    expect(pauseTables()).toBe(0)
  })

  it("a card /clear carried in pauses the replacement 'cleared' until a Resume there", async () => {
    let journal = await open()
    await queueDraft(journal, 'carried', 'source-session')
    expect(reason(journal)).toBe('cleared')
    await journal.close()
    journal = await open()
    expect(reason(journal)).toBe('cleared')
    await journal.appendQueueResume(0)
    expect(reason(journal)).toBeNull()
    expect(pauseTables()).toBe(0)
  })

  it("any accepted turn on the replacement lifts 'cleared', a launch prompt Orca sent included", async () => {
    const journal = await open()
    await queueDraft(journal, 'carried', 'source-session')
    await turn(journal, 'launch', false)
    expect(reason(journal)).toBe('cleared')
    await acceptTurn(journal, 'launch')
    expect(reason(journal)).toBeNull()
  })

  it('rides a tombstone of an id no item takes, so an older build reads it and changes nothing', async () => {
    const journal = await open()
    await turn(journal, 'typed')
    await journal.appendStopEvent({ reason: 'user-stop', turnId: 'turn-1', caller: 'client-1' }, 0)
    const db = new Database(journalDatabasePath(root), { readonly: true })
    const stored = liveTestJournalRows(db, IDENTITY.sessionId)
    db.close()
    const parsed = parseJournalRow(stored.at(-1)?.rowJson ?? '')
    expect(parsed).toMatchObject({
      ok: true,
      row: {
        kind: 'tombstone',
        stopEvent: { reason: 'user-stop', turnId: 'turn-1', caller: 'client-1' }
      }
    })
    if (!parsed.ok || parsed.row.kind !== 'tombstone') {
      throw new Error('expected a tombstone row')
    }
    expect(parsed.row.stopEvent?.at).toBe(parsed.row.ts)
    // An older build ignores the unknown key: the row is an ordinary removal of nothing.
    const { stopEvent: _ignored, ...asOlderBuildReadsIt } = parsed.row
    const state = createJournalReducerState(IDENTITY.sessionId, parsed.row.epoch)
    for (const row of stored.slice(0, -1)) {
      const earlier = parseJournalRow(row.rowJson)
      if (earlier.ok) {
        applyJournalRow(state, earlier.row)
      }
    }
    const items = [...state.items.keys()]
    const submissions = [...state.submissions.keys()]
    applyJournalRow(state, asOlderBuildReadsIt)
    expect([...state.items.keys()]).toEqual(items)
    expect([...state.submissions.keys()]).toEqual(submissions)
  })

  it('a Stop or Resume row holding a value no build writes is ignored on read, never trusted', async () => {
    let journal = await open()
    await queueDraft(journal, 'held')
    /** Appends a row, then reopens with one of its keys rewritten as a corrupt write would. */
    const corrupted = async (
      append: Promise<{ sequence: number }>,
      key: string,
      value: unknown
    ) => {
      const { sequence } = await append
      await journal.close()
      rewriteRows({ [sequence]: [key, value] })
      journal = await open()
    }
    const malformed = [null, 'stopped', { at: 1 }]
    // Pauses nothing as the latest Stop row.
    for (const value of malformed) {
      await corrupted(userStop(journal), 'stopEvent', value)
      expect(reason(journal)).toBeNull()
    }
    // Ends nothing after a person's Stop: neither as a later Stop nor as a Resume.
    await userStop(journal)
    for (const value of malformed) {
      await corrupted(userStop(journal), 'stopEvent', value)
      expect(reason(journal)).toBe('stopped')
    }
    await corrupted(journal.appendQueueResume(0), 'queueResume', 'yes')
    expect(reason(journal)).toBe('stopped')
    expect(held(journal)).toEqual([['held', true]])
  })

  it("the queue's own consume is refused in its transaction while the pause holds the card; Send-now is not", async () => {
    const journal = await open()
    await queueDraft(journal, 'draft-1')
    await userStop(journal)
    const consume = (id: string, automatic: boolean) =>
      journal.appendSubmission(
        {
          clientMessageId: id,
          payloadFingerprint: 'fp-draft-1',
          body: message('draft-1'),
          fence: 0,
          handoverRecorded: true
        },
        {
          messageId: 'draft-1',
          expect: 'waiting',
          settledByOp: null,
          hostInstance: HOST,
          ...(automatic ? { yieldsToPause: true as const } : {})
        }
      )
    await expect(consume('drain-1', true)).rejects.toBeInstanceOf(QueuedMessageNotConsumableError)
    expect(journal.submission('drain-1')).toBeUndefined()
    expect(journal.queuedMessages.get('draft-1')?.state).toBe('waiting')
    await consume('send-now-1', false)
    expect(journal.queuedMessages.get('draft-1')?.state).toBe('dispatched')
  })

  it("a rewind's epoch replacement restates a Stop still pausing, and not one a turn ended", async () => {
    const journal = await open()
    await userStop(journal)
    await journal.replaceEpochItems('handle_forked', 0, [])
    expect(reason(journal)).toBe('stopped')
    await turn(journal, 'typed')
    await journal.replaceEpochItems('handle_forked', 0, [])
    expect(reason(journal)).toBeNull()
  })

  it("only a person's Stop pauses: a host's, a close's or an unknown reason holds nothing", async () => {
    const journal = await open()
    await queueDraft(journal, 'draft-1')
    for (const reason of ['user-close', 'host-stop', 'evict'] as const) {
      await journal.appendStopEvent({ reason }, 0)
    }
    // A newer build's reason this one does not know.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: deliberately outside the type, as a newer build could write it.
    await journal.appendStopEvent({ reason: 'future-reason' as 'evict' }, 0)
    expect(reason(journal)).toBeNull()
  })

  it("a later Stop of any reason ends a person's Stop, without pausing itself", async () => {
    const journal = await open()
    await queueDraft(journal, 'draft-1')
    for (const later of ['host-stop', 'evict', 'user-close'] as const) {
      await userStop(journal)
      expect(held(journal)).toEqual([['draft-1', true]])
      await journal.appendStopEvent({ reason: later }, 0)
      expect(reason(journal)).toBeNull()
      expect(held(journal)).toEqual([['draft-1', false]])
    }
  })

  it("a person's Stop with no later Stop event is not lifted", async () => {
    const journal = await open()
    await queueDraft(journal, 'held')
    await userStop(journal)
    // An eviction writer must write only when it ends a running turn, or it would lift this pause.
    expect(reason(journal)).toBe('stopped')
    expect(held(journal)).toEqual([['held', true]])
  })

  it('the restated Stop is the same event: its reason, turn, caller and time', async () => {
    const journal = await open()
    await journal.appendStopEvent({ reason: 'user-stop', turnId: 'turn-7', caller: 'phone' }, 0)
    const stopped = stopEvents()
    await journal.replaceEpochItems('handle_forked', 0, [])
    expect(stopEvents()).toEqual(stopped)
    expect(stopped).toEqual([
      { reason: 'user-stop', turnId: 'turn-7', caller: 'phone', at: expect.any(Number) }
    ])
  })

  it.each([
    ['an accepted turn', (journal: AgentSessionJournal) => turn(journal, 'typed')],
    ['a Resume', (journal: AgentSessionJournal) => journal.appendQueueResume(0)]
  ])('a /clear pause %s already lifted stays lifted across a rewind', async (_name, lift) => {
    const journal = await open()
    await queueDraft(journal, 'carried', 'source-session')
    await lift(journal)
    expect(reason(journal)).toBeNull()
    await journal.replaceEpochItems('handle_forked', 0, [])
    expect(reason(journal)).toBeNull()
  })

  it('a lifted /clear pause and a later Stop are both restated, the Stop still in force', async () => {
    const journal = await open()
    await queueDraft(journal, 'carried', 'source-session')
    await turn(journal, 'typed')
    await userStop(journal)
    await journal.replaceEpochItems('handle_forked', 0, [])
    expect(journal.queuedMessages.pauses().map((pause) => pause.reason)).toEqual(['stopped'])
    await journal.appendQueueResume(0)
    expect(reason(journal)).toBeNull()
  })
})

describe('which cards a pause holds', () => {
  it('only cards queued before the Stop event: one queued after it is a new instruction', async () => {
    let journal = await open()
    await queueDraft(journal, 'before')
    await userStop(journal)
    await queueDraft(journal, 'after')
    expect(held(journal)).toEqual([
      ['before', true],
      ['after', false]
    ])
    await journal.close()
    journal = await open()
    expect(held(journal)).toEqual([
      ['before', true],
      ['after', false]
    ])
  })

  it('a steer the Stop withdrew comes back in its own place, and is held', async () => {
    const journal = await open()
    await queueDraft(journal, 'steered')
    await journal.appendSubmission(
      {
        clientMessageId: 'send-now-1',
        payloadFingerprint: 'fp-steered',
        body: message('steered'),
        fence: 0,
        handoverRecorded: true
      },
      { messageId: 'steered', expect: 'waiting', settledByOp: null, hostInstance: HOST }
    )
    await userStop(journal)
    await queueDraft(journal, 'after')
    await journal.resolveDispatch({
      clientMessageId: 'send-now-1',
      state: 'rejected',
      ...agentSessionFailureWords(agentSessionFailureFact('cancelled'), { surface: 'rejection' }),
      fence: 0
    })
    expect(held(journal)).toEqual([
      ['steered', true],
      ['after', false]
    ])
  })

  it("the queue's own consume refuses a newer card while an older one is held: nothing overtakes", async () => {
    const journal = await open()
    await queueDraft(journal, 'held')
    await userStop(journal)
    await queueDraft(journal, 'newer')
    await expect(
      journal.appendSubmission(
        {
          clientMessageId: 'drain-newer',
          payloadFingerprint: 'fp-newer',
          body: message('newer'),
          fence: 0,
          handoverRecorded: true
        },
        {
          messageId: 'newer',
          expect: 'waiting',
          settledByOp: null,
          hostInstance: HOST,
          yieldsToPause: true
        }
      )
    ).rejects.toBeInstanceOf(QueuedMessageNotConsumableError)
    expect(journal.queuedMessages.get('newer')?.state).toBe('waiting')
  })

  it("'cleared' holds the carried cards, not one typed after them", async () => {
    const journal = await open()
    await queueDraft(journal, 'carried-1', 'source-session')
    await queueDraft(journal, 'carried-2', 'source-session')
    await queueDraft(journal, 'typed-here')
    expect(held(journal)).toEqual([
      ['carried-1', true],
      ['carried-2', true],
      ['typed-here', false]
    ])
  })
})

describe("a reopen's pause", () => {
  /** This handle closes and the next one opens and marks it, as a quit, a crash or a chat close
   *  leaves it; `failMark` makes the mark's write fail. */
  async function reopen(
    journal: AgentSessionJournal,
    failMark = false
  ): Promise<AgentSessionJournal> {
    await journal.close()
    const reopened = await open()
    if (failMark) {
      vi.spyOn(reopened, 'appendQueueReopen').mockRejectedValueOnce(new Error('disk full'))
      await expect(reopened.markQueueReopen(0)).rejects.toThrow('disk full')
    } else {
      await reopened.markQueueReopen(0)
    }
    return reopened
  }

  it('holds the cards queued before the reopen, never one queued after its mark', async () => {
    let journal = await open()
    await queueDraft(journal, 'before')
    expect(reason(journal)).toBeNull()
    journal = await reopen(journal)
    await queueDraft(journal, 'after')
    expect(held(journal)).toEqual([
      ['before', true],
      ['after', false]
    ])
    expect(reason(journal)).toBe('restarted')
  })

  it.each([
    ['an accepted turn', (journal: AgentSessionJournal) => turn(journal, 'carry-on')],
    ['a Resume', (journal: AgentSessionJournal) => journal.appendQueueResume(0)]
  ])('%s after the reopen lifts it', async (_name, lift) => {
    let journal = await open()
    await queueDraft(journal, 'before')
    journal = await reopen(journal)
    await lift(journal)
    expect(reason(journal)).toBeNull()
  })

  it('a turn the agent has not accepted yet lifts nothing', async () => {
    let journal = await open()
    await queueDraft(journal, 'before')
    journal = await reopen(journal)
    await turn(journal, 'carry-on', false)
    expect(reason(journal)).toBe('restarted')
  })

  // A hand-off in flight may come back to waiting after the open: the open marks for it too.
  it('marks a reopen whose only card is mid-hand-off, and holds it once it comes back', async () => {
    let journal = await open()
    await queueDraft(journal, 'in-flight')
    await journal.appendSubmission(
      {
        clientMessageId: 'drain-1',
        payloadFingerprint: 'fp-in-flight',
        body: message('in-flight'),
        fence: 0,
        handoverRecorded: true
      },
      { messageId: 'in-flight', expect: 'waiting', settledByOp: null, hostInstance: HOST }
    )
    journal = await reopen(journal)
    await journal.resolveDispatch({
      clientMessageId: 'drain-1',
      state: 'rejected',
      ...agentSessionFailureWords(agentSessionFailureFact('notDelivered'), {
        surface: 'rejection'
      }),
      fence: 0
    })
    expect(held(journal)).toEqual([['in-flight', true]])
  })

  // Written after a later send was accepted, the mark starts where the chat stopped, so that
  // send still lifts it; it never narrows a wider mark before it.
  it('a mark written late starts where the chat stopped, and narrows no earlier mark', async () => {
    const journal = await open()
    await queueDraft(journal, 'kept')
    const stopped = journal.cursor().sequence + 1
    await turn(journal, 'later')
    await journal.markQueueReopen(0, stopped)
    expect(reason(journal)).toBeNull()

    const reopened = await reopen(journal)
    expect(reason(reopened)).toBe('restarted')
    await reopened.markQueueReopen(0, stopped)
    expect(reason(reopened)).toBe('restarted')
  })

  it('a reopen with no waiting card writes nothing', async () => {
    let journal = await open()
    await turn(journal, 'earlier')
    const before = journal.cursor()
    journal = await reopen(journal)
    expect(journal.cursor()).toEqual(before)
    await queueDraft(journal, 'after')
    expect(held(journal)).toEqual([['after', false]])
  })

  it('a second reopen before any turn still holds them; one after a turn holds them again', async () => {
    let journal = await open()
    await queueDraft(journal, 'before')
    journal = await reopen(journal)
    journal = await reopen(journal)
    expect(reason(journal)).toBe('restarted')
    await turn(journal, 'carry-on')
    expect(reason(journal)).toBeNull()
    // Still waiting (here, nothing drained it): the chat closed with it again, so it waits again.
    journal = await reopen(journal)
    expect(reason(journal)).toBe('restarted')
  })

  // The open could not write its mark: the open itself is the boundary, so nothing sends by
  // itself; the next turn or Resume lifts it, and the next open marks again.
  it('without a mark the open itself is where the pause begins', async () => {
    let journal = await open()
    await queueDraft(journal, 'before')
    journal = await reopen(journal, true)
    expect(held(journal)).toEqual([['before', true]])
    await turn(journal, 'carry-on')
    expect(reason(journal)).toBeNull()
  })

  it("reads an earlier build's stored 'kept' and 'stopped' holds as none; send_failed stays", async () => {
    let journal = await open()
    for (const id of ['was-kept', 'was-stopped', 'failed']) {
      await queueDraft(journal, id)
    }
    await journal.queuedMessages.hold({ messageIds: ['failed'], reason: 'send_failed' })
    const db = new Database(journalDatabasePath(root))
    for (const [id, stored] of [
      ['was-kept', 'kept'],
      ['was-stopped', 'stopped']
    ]) {
      db.prepare('UPDATE queued_messages SET hold_reason = ? WHERE message_id = ?').run(stored, id)
    }
    db.close()
    journal = await reopen(journal)
    expect(journal.queuedMessages.list().map((row) => [row.messageId, row.holdReason])).toEqual([
      ['was-kept', null],
      ['was-stopped', null],
      ['failed', 'send_failed']
    ])
    expect(held(journal)).toEqual([
      ['was-kept', true],
      ['was-stopped', true],
      ['failed', false]
    ])
  })
})

describe('which cards the pauses in force hold', () => {
  type Card = Parameters<typeof queuePauseHolding>[1] & { messageId: string }

  function card(messageId: string, queuedAfter: number, fields: Partial<Card> = {}): Card {
    const queuedAt = { epoch: 'epoch-1', sequence: queuedAfter + 1 }
    const base = { state: 'waiting', holdReason: null, carriedFrom: null }
    return { messageId, ...base, queuedAt, ...fields }
  }

  /** A Stop at sequence 5 unless `stopped` is 0; this handle opened at `opened` and could not mark
   *  it (0: nothing to mark); no turn, Resume or reopen mark since. */
  function pausesOver(cards: readonly Card[], stopped = 5, opened = 0) {
    return deriveQueuePauses({
      epoch: 'epoch-1',
      marks: {
        latestStop: stopped ? { sequence: stopped, event: { reason: 'user-stop', at: 0 } } : null,
        resumedSequence: 0,
        reopenedSequence: 0
      },
      latestAcceptedTurnSequence: 0,
      cards,
      reopenFloor: opened ? { epoch: 'epoch-1', sequence: opened + 1 } : null
    })
  }

  function holding(
    cards: readonly Card[],
    stopped?: number,
    opened?: number
  ): [string, string | null][] {
    const pauses = pausesOver(cards, stopped, opened)
    return cards.map((each) => [each.messageId, queuePauseHolding(pauses, each)?.reason ?? null])
  }

  it('a Stop holds a card with no recorded position, and one queued before a rewind', () => {
    const cards = [
      card('unrecorded', 5, { queuedAt: null }),
      // Later in its own epoch than the Stop is in this one: only the epoch says it came first.
      card('before-rewind', 5, { queuedAt: { epoch: 'epoch-0', sequence: 9 } }),
      card('after', 5)
    ]
    expect(holding(cards)).toEqual([
      ['unrecorded', 'stopped'],
      ['before-rewind', 'stopped'],
      ['after', null]
    ])
  })

  it("a Stop that holds nothing never hides a reopen's: a card from before the open waits", () => {
    const after = card('after', 5)
    expect(pausesOver([after], 5, 6).map((pause) => pause.reason)).toEqual(['stopped', 'restarted'])
    expect(holding([after], 5, 6)).toEqual([['after', 'restarted']])
    expect(nextSendableQueuedCard(pausesOver([after], 5, 6), [after])).toBeNull()
    // Queued since the open, nothing holds it: a card queued after a Stop sends normally.
    expect(nextSendableQueuedCard(pausesOver([after]), [after])).toBe(after)
  })

  it("a card names the first pause holding it, and the header names the first held card's", () => {
    const cards = [card('before', 3), card('after', 5)]
    expect(holding(cards, 5, 6)).toEqual([
      ['before', 'stopped'],
      ['after', 'restarted']
    ])
    expect(resumableQueuePause(pausesOver(cards, 5, 6), cards)?.reason).toBe('stopped')
  })

  // R13-1: a message Orca kept after a quit is an ordinary card, in order, under the reopen's pause.
  it('a card from before the open waits in order, and so do the cards behind it', () => {
    const cards = [card('kept', 1), card('behind', 2)]
    expect(holding(cards, 0, 4)).toEqual([
      ['kept', 'restarted'],
      ['behind', 'restarted']
    ])
    expect(nextSendableQueuedCard(pausesOver(cards, 0, 4), cards)).toBeNull()
  })

  // A card held on its own waits for its own Send, so it starts no reopen pause for the others.
  it('a card held on its own from before the open starts no reopen pause', () => {
    const cards = [card('held', 1, { holdReason: 'send_failed' }), card('live', 5)]
    expect(pausesOver(cards, 0, 4)).toEqual([])
    expect(nextSendableQueuedCard(pausesOver(cards, 0, 4), cards)?.messageId).toBe('live')
  })

  it("a /clear's pause that holds nothing never hides a reopen's", () => {
    const cards = [
      card('carried', 1, { carriedFrom: 'source-session', holdReason: 'send_failed' }),
      card('typed', 2)
    ]
    expect(pausesOver(cards, 0, 4).map((pause) => pause.reason)).toEqual(['cleared', 'restarted'])
    expect(holding(cards, 0, 4)).toEqual([
      ['carried', null],
      ['typed', 'restarted']
    ])
    expect(nextSendableQueuedCard(pausesOver(cards, 0, 4), cards)).toBeNull()
  })
})
