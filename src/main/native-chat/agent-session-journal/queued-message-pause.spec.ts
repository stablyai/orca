// Derive pauses from journal rows; never maintain a second stored pause state.

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
import { QueuedMessageNotConsumableError } from './queued-message-consume-error'
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
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'

export function registerQueuedMessagePauseTests(): void {
  const IDENTITY: AgentSessionJournalIdentity = {
    sessionId: 'session-p',
    workspaceId: 'ws-1',
    hostId: 'host-1',
    agent: 'claude',
    providerHandle: claudeProviderHandle('native-1', null)
  }

  let root: string
  let clock = 1_000
  const journals = createTrackedJournalOpener()

  function message(text: string): AgentJournalMessageItem {
    return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
  }

  function fingerprintOf(text: string): string {
    return agentSessionSendBodyFingerprint(IDENTITY.sessionId, message(text))
  }

  function open(): Promise<AgentSessionJournal> {
    return journals.open({
      identity: IDENTITY,
      stateDirectory: root,
      now: () => ++clock,
      mintEpoch: () => `epoch-${clock}`
    })
  }

  function queueDraft(journal: AgentSessionJournal, messageId: string) {
    return journal.queuedMessages.insert({ messageId, body: message(messageId) })
  }

  function clearContext(journal: AgentSessionJournal) {
    return journal.context.clear(
      { operationId: `clear-${++clock}`, afterFence: 0, clearedAt: clock },
      { write: () => {}, committed: () => {} }
    )
  }

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

  function userStop(journal: AgentSessionJournal) {
    return journal.appendStopEvent({ reason: 'user-stop' }, 0)
  }

  function reason(journal: AgentSessionJournal): string | null {
    return journal.queuedMessages.pauses()[0]?.reason ?? null
  }

  function held(journal: AgentSessionJournal): [string, boolean][] {
    const pauses = journal.queuedMessages.pauses()
    return journal.queuedMessages
      .list()
      .filter((card) => card.state === 'waiting')
      .map((card) => [card.messageId, queuePauseHolding(pauses, card) !== undefined])
  }

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
      // Late acceptance of a pre-Stop send cannot lift the pause.
      await acceptTurn(journal, 'before-stop')
      expect(reason(journal)).toBe('stopped')
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

    it('a card kept by /clear stays paused until Resume in the same journal', async () => {
      let journal = await open()
      await queueDraft(journal, 'carried')
      await clearContext(journal)
      expect(reason(journal)).toBe('cleared')
      await journal.close()
      journal = await open()
      expect(reason(journal)).toBe('cleared')
      await journal.appendQueueResume(0)
      expect(reason(journal)).toBeNull()
      expect(pauseTables()).toBe(0)
    })

    it('any accepted turn after /clear lifts its pause, a launch prompt Orca sent included', async () => {
      const journal = await open()
      await queueDraft(journal, 'carried')
      await clearContext(journal)
      await turn(journal, 'launch', false)
      expect(reason(journal)).toBe('cleared')
      await acceptTurn(journal, 'launch')
      expect(reason(journal)).toBeNull()
    })

    it('rides a tombstone of an id no item takes, so an older build reads it and changes nothing', async () => {
      const journal = await open()
      await turn(journal, 'typed')
      await journal.appendStopEvent(
        { reason: 'user-stop', turnId: 'turn-1', caller: 'client-1' },
        0
      )
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
      // Older readers ignore the annotation and remove a nonexistent item.
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
      for (const value of malformed) {
        await corrupted(userStop(journal), 'stopEvent', value)
        expect(reason(journal)).toBeNull()
      }
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
            payloadFingerprint: fingerprintOf('draft-1'),
            body: message('draft-1'),
            fence: 0,
            handoverRecorded: true
          },
          {
            messageId: 'draft-1',
            expect: 'waiting',
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
      // Eviction rows must describe ended work or they would incorrectly lift this pause.
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
      await queueDraft(journal, 'carried')
      await clearContext(journal)
      await lift(journal)
      expect(reason(journal)).toBeNull()
      await journal.replaceEpochItems('handle_forked', 0, [])
      expect(reason(journal)).toBeNull()
    })

    it('a lifted /clear pause and a later Stop are both restated, the Stop still in force', async () => {
      const journal = await open()
      await queueDraft(journal, 'carried')
      await clearContext(journal)
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
          payloadFingerprint: fingerprintOf('steered'),
          body: message('steered'),
          fence: 0,
          handoverRecorded: true
        },
        { messageId: 'steered', expect: 'waiting' }
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
            payloadFingerprint: fingerprintOf('newer'),
            body: message('newer'),
            fence: 0,
            handoverRecorded: true
          },
          {
            messageId: 'newer',
            expect: 'waiting',
            yieldsToPause: true
          }
        )
      ).rejects.toBeInstanceOf(QueuedMessageNotConsumableError)
      expect(journal.queuedMessages.get('newer')?.state).toBe('waiting')
    })

    it("'cleared' holds the cards already queued, not one typed after it", async () => {
      const journal = await open()
      await queueDraft(journal, 'carried-1')
      await queueDraft(journal, 'carried-2')
      await clearContext(journal)
      await queueDraft(journal, 'typed-here')
      expect(held(journal)).toEqual([
        ['carried-1', true],
        ['carried-2', true],
        ['typed-here', false]
      ])
    })
  })

  describe("a reopen's pause", () => {
    /** Reopen as a new handle; failMark injects a reopen-mark write failure. */
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

    it('marks a reopen whose only card is mid-hand-off, and holds it once it comes back', async () => {
      let journal = await open()
      await queueDraft(journal, 'in-flight')
      await journal.appendSubmission(
        {
          clientMessageId: 'drain-1',
          payloadFingerprint: fingerprintOf('in-flight'),
          body: message('in-flight'),
          fence: 0,
          handoverRecorded: true
        },
        { messageId: 'in-flight', expect: 'waiting' }
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
      journal = await reopen(journal)
      expect(reason(journal)).toBe('restarted')
    })

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
      const db = new Database(journalDatabasePath(root))
      for (const [position, id, stored] of [
        [1, 'was-kept', 'kept'],
        [2, 'was-stopped', 'stopped'],
        [3, 'failed', 'send_failed']
      ] as const) {
        db.prepare(
          `INSERT INTO queued_messages (session_id, message_id, position, body_json, fingerprint,
             created_at, host_instance, state, hold_reason)
           VALUES (?, ?, ?, ?, '', 0, 'earlier', 'waiting', ?)`
        ).run(IDENTITY.sessionId, id, position, JSON.stringify(message(id)), stored)
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
      const base = { state: 'waiting', holdReason: null }
      return { messageId, ...base, queuedAt, ...fields }
    }

    /** Simulate Stop/open boundaries with no subsequent turn, Resume or reopen mark. */
    function pausesOver(cards: readonly Card[], stopped = 5, opened = 0, clearedIds?: string[]) {
      return deriveQueuePauses({
        epoch: 'epoch-1',
        marks: {
          latestStop: stopped ? { sequence: stopped, event: { reason: 'user-stop', at: 0 } } : null,
          resumedSequence: 0,
          reopenedSequence: 0,
          ...(clearedIds
            ? { cleared: { sequence: 4, operationId: 'clear', messageIds: clearedIds } }
            : {})
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
        // Epoch precedence outranks raw sequence values.
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
      expect(pausesOver([after], 5, 6).map((pause) => pause.reason)).toEqual([
        'stopped',
        'restarted'
      ])
      expect(holding([after], 5, 6)).toEqual([['after', 'restarted']])
      expect(nextSendableQueuedCard(pausesOver([after], 5, 6), [after])).toBeNull()
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

    it('a card from before the open waits in order, and so do the cards behind it', () => {
      const cards = [card('kept', 1), card('behind', 2)]
      expect(holding(cards, 0, 4)).toEqual([
        ['kept', 'restarted'],
        ['behind', 'restarted']
      ])
      expect(nextSendableQueuedCard(pausesOver(cards, 0, 4), cards)).toBeNull()
    })

    it('a card held on its own from before the open starts no reopen pause', () => {
      const cards = [card('held', 1, { holdReason: 'send_failed' }), card('live', 5)]
      expect(pausesOver(cards, 0, 4)).toEqual([])
      expect(nextSendableQueuedCard(pausesOver(cards, 0, 4), cards)?.messageId).toBe('live')
    })

    it("a /clear's pause that holds nothing never hides a reopen's", () => {
      const cards = [card('cleared', 1, { holdReason: 'send_failed' }), card('typed', 2)]
      const pauses = pausesOver(cards, 0, 4, ['cleared'])
      expect(pauses.map((pause) => pause.reason)).toEqual(['cleared', 'restarted'])
      expect(
        cards.map((each) => [each.messageId, queuePauseHolding(pauses, each)?.reason ?? null])
      ).toEqual([
        ['cleared', null],
        ['typed', 'restarted']
      ])
      expect(nextSendableQueuedCard(pauses, cards)).toBeNull()
    })
  })
}
