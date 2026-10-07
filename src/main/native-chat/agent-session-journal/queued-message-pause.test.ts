// The queue's pause is a pure function of the journal: a Stop and a Resume are rows, an accepted
// turn is a row, and a /clear's carried card names its source. Nothing is stored beside
// them, so nothing has to retire.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
import { QUEUED_MESSAGE_PAUSED_KEPT } from '../../../shared/agent-session-queued-message-wire'
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
  return journal.queuedMessages.pauses(HOST)[0]?.reason ?? null
}

/** Each card, and whether a pause in force holds it. */
function held(journal: AgentSessionJournal): [string, boolean][] {
  const pauses = journal.queuedMessages.pauses(HOST)
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
          ...(automatic ? { yieldsToPause: { hostInstance: HOST } } : {})
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
    expect(journal.queuedMessages.pauses(HOST).map((pause) => pause.reason)).toEqual(['stopped'])
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
          yieldsToPause: { hostInstance: HOST }
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

describe("a restart's pause", () => {
  it("adopting a restart's rows moves them into this instance and clears an older build's stored 'stopped' hold; send_failed stays", async () => {
    const journal = await open()
    await journal.queuedMessages.insert({
      messageId: 'draft-restart',
      body: message('written before the restart'),
      fingerprint: 'fp-draft-restart',
      hostInstance: 'proc-0'
    })
    expect(reason(journal)).toBe('restarted')
    await queueDraft(journal, 'draft-legacy')
    await queueDraft(journal, 'draft-failed')
    await journal.queuedMessages.hold({ messageIds: ['draft-failed'], reason: 'send_failed' })
    const db = new Database(journalDatabasePath(root))
    db.prepare("UPDATE queued_messages SET hold_reason = 'stopped' WHERE message_id = ?").run(
      'draft-legacy'
    )
    db.close()
    journal.queuedMessages.invalidate()
    expect(await journal.queuedMessages.adopt(HOST)).toBe(true)
    expect(reason(journal)).toBeNull()
    expect(
      journal.queuedMessages.list().map((row) => [row.messageId, row.hostInstance, row.holdReason])
    ).toEqual([
      ['draft-restart', HOST, null],
      ['draft-legacy', HOST, null],
      ['draft-failed', HOST, 'send_failed']
    ])
  })

  it('adoption and Resume keep a kept card held: only its own Send, Edit or Delete releases it', async () => {
    const journal = await open()
    const kept = await journal.queuedMessages.insert({
      messageId: 'kept',
      body: message('kept across a restart'),
      fingerprint: 'fp-kept',
      hostInstance: 'proc-0',
      holdReason: QUEUED_MESSAGE_PAUSED_KEPT
    })
    expect(kept.holdReason).toBe(QUEUED_MESSAGE_PAUSED_KEPT)
    expect(await journal.queuedMessages.adopt(HOST)).toBe(true)
    expect(journal.queuedMessages.get('kept')).toMatchObject({
      hostInstance: HOST,
      holdReason: QUEUED_MESSAGE_PAUSED_KEPT
    })
  })

  it('an adoption with nothing to adopt changes nothing and fires no commit notification', async () => {
    const journal = await open()
    await queueDraft(journal, 'draft-1')
    const revision = journal.queuedMessages.revision()
    expect(await journal.queuedMessages.adopt(HOST)).toBe(false)
    expect(journal.queuedMessages.revision()).toBe(revision)
  })
})

describe('which cards the pauses in force hold', () => {
  type Card = Parameters<typeof queuePauseHolding>[1] & { messageId: string }
  const DEAD = 'proc-0'

  function card(messageId: string, queuedAfter: number, fields: Partial<Card> = {}): Card {
    const queuedAt = { epoch: 'epoch-1', sequence: queuedAfter + 1 }
    const base = { state: 'waiting', holdReason: null, hostInstance: HOST, carriedFrom: null }
    return { messageId, ...base, queuedAt, ...fields }
  }

  /** A Stop at sequence 5 unless `stopped` is 0; no turn or Resume since. */
  function pausesOver(cards: readonly Card[], stopped = 5) {
    return deriveQueuePauses({
      epoch: 'epoch-1',
      marks: {
        latestStop: stopped ? { sequence: stopped, event: { reason: 'user-stop', at: 0 } } : null,
        resumedSequence: 0
      },
      latestAcceptedTurnSequence: 0,
      cards,
      hostInstance: HOST,
      restartEnded: false
    })
  }

  function holding(cards: readonly Card[], stopped?: number): [string, string | null][] {
    const pauses = pausesOver(cards, stopped)
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

  it("a Stop that holds nothing never hides a restart's: a dead process's card queued after it waits", () => {
    const after = card('after', 5, { hostInstance: DEAD })
    expect(pausesOver([after]).map((pause) => pause.reason)).toEqual(['stopped', 'restarted'])
    expect(holding([after])).toEqual([['after', 'restarted']])
    expect(nextSendableQueuedCard(pausesOver([after]), [after])).toBeNull()
    expect(resumableQueuePause(pausesOver([after]), [after])?.reason).toBe('restarted')
    // Written by this process, nothing holds it: a card queued after a Stop sends normally.
    const live = card('after', 5)
    expect(nextSendableQueuedCard(pausesOver([live]), [live])).toBe(live)
  })

  it("a card names the first pause holding it, and the header names the first held card's", () => {
    const cards = [
      card('before', 3, { hostInstance: DEAD }),
      card('after', 5, { hostInstance: DEAD })
    ]
    expect(holding(cards)).toEqual([
      ['before', 'stopped'],
      ['after', 'restarted']
    ])
    expect(resumableQueuePause(pausesOver(cards), cards)?.reason).toBe('stopped')
  })

  // Held on its own, as a card whose send failed: the queue goes past it, and Resume is offered
  // over the cards a pause holds behind it.
  it('a kept card is skipped like a send_failed one; the cards behind it still send', () => {
    const behind = card('behind', 2)
    const kept = [card('kept', 1, { holdReason: QUEUED_MESSAGE_PAUSED_KEPT }), behind]
    expect(holding(kept, 0)).toEqual([
      ['kept', null],
      ['behind', null]
    ])
    expect(nextSendableQueuedCard(pausesOver(kept, 0), kept)).toBe(behind)
    expect(resumableQueuePause(pausesOver(kept, 0), kept)).toBeNull()
    const restarted = [kept[0]!, card('dead', 2, { hostInstance: DEAD })]
    expect(nextSendableQueuedCard(pausesOver(restarted, 0), restarted)).toBeNull()
    expect(resumableQueuePause(pausesOver(restarted, 0), restarted)?.reason).toBe('restarted')
  })

  // A dead process's card held on its own waits for its own Send, so it pauses no other card.
  it('a card held on its own from a dead process starts no restart pause', () => {
    for (const holdReason of [QUEUED_MESSAGE_PAUSED_KEPT, 'send_failed']) {
      const cards = [card('held', 1, { hostInstance: DEAD, holdReason }), card('live', 2)]
      expect(pausesOver(cards, 0)).toEqual([])
      expect(nextSendableQueuedCard(pausesOver(cards, 0), cards)?.messageId).toBe('live')
    }
  })

  it("a /clear's pause that holds nothing never hides a restart's", () => {
    const cards = [
      card('carried', 1, { carriedFrom: 'source-session', holdReason: 'send_failed' }),
      card('typed', 2, { hostInstance: DEAD })
    ]
    expect(pausesOver(cards, 0).map((pause) => pause.reason)).toEqual(['cleared', 'restarted'])
    expect(holding(cards, 0)).toEqual([
      ['carried', null],
      ['typed', 'restarted']
    ])
    expect(nextSendableQueuedCard(pausesOver(cards, 0), cards)).toBeNull()
  })
})
