import * as legacyChange from '../agent-session-journal/journal-queue-legacy-change'
import {
  readTestJournalOutcomes,
  appendTestJournalQueueRow,
  finishTestJournalHistoricalInputs
} from '../agent-session-journal/journal-host-database-test-support'
import { outcomeFormat1EntryParsers } from '../agent-session-journal/journal-outcome-format-1'
import { expect, it, vi } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalAnsweredTurnIdentity
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { agentSessionSendBodyFingerprint } from '../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { AgentSessionSubscribers } from './structured-agent-session-subscribers'
import { readPublishedQueuedMessages } from './structured-agent-session-queued-publication'
import { buildSubscriberFrame } from './agent-session-subscriber-frame-fields'
import { boundedQueuePublication } from './agent-session-bounded-queue'
import { BOUNDED_FRAME_CONTENT_BUDGET_BYTES } from './agent-session-history-page-bounds'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from '../../../shared/agent-session/structured-agent-session-reducer'
import {
  projectQueuedMessageCards,
  queuedMessagesQueuePause
} from '../../../shared/agent-session/view/structured-agent-session-queued-cards'
import {
  SESSION,
  db,
  message,
  words,
  journalFor,
  historicalJournalFor,
  seedLegacy,
  legacyIds,
  threadWrite,
  type Legacy
} from './structured-agent-session-queued-legacy-import.test-fixture'

async function handOff(
  journal: AgentSessionJournal,
  attempt: string,
  card: string,
  text: string,
  as: 'providerRejected' | 'cancelled' | 'accepted',
  fence = 0,
  beforeAnswer?: () => Promise<void>,
  answeredInTurn?: AgentJournalAnsweredTurnIdentity,
  consume = false
): Promise<void> {
  const body = message(text)
  const payloadFingerprint = agentSessionSendBodyFingerprint(journal.queuedMessages.sessionId, body)
  await journal.appendSubmission(
    {
      clientMessageId: attempt,
      payloadFingerprint,
      body,
      fence,
      handoverRecorded: true,
      queuedMessageId: card
    },
    consume ? { messageId: card, expect: 'waiting' } : undefined
  )
  await journal.resolveDispatch({
    clientMessageId: attempt,
    state: 'pending',
    fence,
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
  await beforeAnswer?.()
  await journal.resolveDispatch(
    as === 'accepted'
      ? { clientMessageId: attempt, state: 'accepted', providerIdentity: null, fence }
      : { clientMessageId: attempt, state: 'rejected', ...words(as), fence, answeredInTurn }
  )
}

it.each([100, 1_000])('raw selection reuse: %i waiting cards', async (size) => {
  const journal = journalFor(SESSION)
  const rows = Array.from({ length: size }, (_, i): Legacy => [`waiting-${i}`, 'waiting', 'words'])
  seedLegacy(SESSION, rows)
  db().exec(`CREATE TEMP TRIGGER b2_raw_fail_import BEFORE DELETE ON queued_messages
    BEGIN SELECT RAISE(ABORT, 'disk full'); END`)
  await journal.open()
  expect(legacyIds()).toHaveLength(size)
  const feed = new AgentSessionSubscribers()
  const base = { sessionId: SESSION, journal, fence: 0, cursor: journal.cursor() }
  const received: AgentSessionSubscribeEvent[][] = [[], [], []]
  received.forEach((events, index) =>
    feed.open({
      ...base,
      id: String(index),
      boundedFrames: index === 1,
      snapshotCatchUp: index !== 2,
      readsCurrentRequests: index !== 2,
      emit: (event) => events.push(event)
    })
  )
  let visits = 0
  let classified = 0
  const classify = legacyChange.legacyQueuedChange
  const classifications = vi
    .spyOn(legacyChange, 'legacyQueuedChange')
    .mockImplementation((...args) => {
      classified++
      return classify(...args)
    })
  const flatMap = Array.prototype.flatMap
  const scans = vi.spyOn(Array.prototype, 'flatMap')
  scans.mockImplementation(function (this: { messageId?: string }[], callback, thisArg) {
    const legacy = this.length === size && this[0]?.messageId === 'waiting-0'
    return flatMap.call(this, (...args) => {
      visits += legacy ? 1 : 0
      return callback.apply(thisArg, args)
    })
  })
  try {
    const turn = { provider: 'codex' as const, threadId: 'progress', turnId: 't', ordinal: 0 }
    await journal.appendItem(turn, message('progress'), threadWrite)
    feed.publish(SESSION, journal)
    // Canonical history reads do not materialize legacy waiting cards.
    expect(visits).toBe(0)
    expect(journal.publicRead().normalizationKey).toBe('')
    expect(journal.queuedMessages.list().filter((c) => c.state === 'waiting')).toHaveLength(size)
    expect(visits).toBe(0)
    expect(classified).toBe(0)
    for (const events of received) {
      const items = events.flatMap((e) => (e.type === 'batch' ? e.batch.items : []))
      expect(items.map((i) => i.body)).toContainEqual(message('progress'))
      expect(events.filter((e) => e.type === 'snapshot')).toHaveLength(0)
    }
    visits = 0
    classified = 0
    for (let p = 0; p < 5; p++) {
      feed.publish(SESSION, journal)
    }
    expect(visits).toBe(0)
    expect(classified).toBe(0)
    const answered = { turn: { ...turn, ordinal: -1 }, via: 'steer' as const }
    await handOff(journal, 'u', 'waiting-0', 'words', 'cancelled', 0, undefined, answered, true)
    expect(classified).toBeLessThanOrEqual(2 * size)
    classified = 0
    const raw = structuredClone(journal.submission('u'))
    const saved = readTestJournalOutcomes(db(), SESSION)
    feed.publish(SESSION, journal)
    const view = journal.publicRead()
    expect(view.normalizationKey).not.toBe('')
    expect(view.snapshot.submissions.find((s) => s.clientMessageId === 'u')).toMatchObject({
      dispatchState: 'unknown',
      queuedMessageId: 'waiting-0'
    })
    const item = view.snapshot.items.find((i) => i.itemId === agentJournalSubmissionKey('u'))
    expect(item?.body).toEqual(message('words'))
    expect(item?.sequence).toBeLessThan(journal.cursor().sequence)
    expect(journal.submissionBody('u')).toEqual(message('words'))
    expect(journal.submission('u')).toMatchObject({ dispatchState: 'unknown' })
    expect(journal.submission('u')?.submittedSequence).toBeLessThan(journal.cursor().sequence)
    const storedSends = saved
      .filter(
        (row) => row.field === 'submissions' && row.key === JSON.stringify('u') && !row.deleted
      )
      .map((row) => outcomeFormat1EntryParsers.submissions.parse(JSON.parse(row.json))[1])
    expect(storedSends.at(-1)).toEqual(raw)
    expect(raw).toMatchObject({ dispatchState: 'unknown', recovered: true })
    expect(journal.submission('u')).toEqual(raw)
    expect(readTestJournalOutcomes(db(), SESSION)).toEqual(saved)
    // Derived family eligibility and presentation do not rewrite committed format-2 observations.
    expect(journal.receiptFor('u')).toBeNull()
    expect(journal.queuedMessages.get('waiting-0')).toMatchObject({
      state: 'dispatched',
      consumedAs: 'u'
    })
    expect(visits).toBeLessThanOrEqual(2 * size)
    expect(classified).toBeLessThanOrEqual(size)
    visits = 0
    classified = 0
    for (let p = 0; p < 5; p++) {
      feed.publish(SESSION, journal)
    }
    expect(visits).toBe(0)
    expect(classified).toBe(0)
    expect(received.map((es) => es.filter((e) => e.type === 'snapshot').length)).toEqual([1, 1, 0])
  } finally {
    scans.mockRestore()
    classifications.mockRestore()
    db().exec('DROP TRIGGER b2_raw_fail_import')
    await journal.close()
  }
})

it('carries saved independent holds through real publication, bounded snapshot/reset/catch-up/live and the shared reducer', async () => {
  const sessionId = 'historical-public-read'
  const journal = historicalJournalFor(sessionId)
  await journal.open()
  try {
    const body = message('immutable full original')
    await journal.appendSubmission({
      clientMessageId: 'original',
      body,
      payloadFingerprint: agentSessionSendBodyFingerprint(sessionId, body),
      fence: 0,
      origin: 'client',
      handoverRecorded: true,
      options: { model: 'default' }
    })
    await journal.resolveDispatch({
      clientMessageId: 'original',
      state: 'pending',
      fence: 0,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    appendTestJournalQueueRow(db(), journal, 'recovery:original', {
      op: 'queued',
      body,
      recovers: 'original',
      position: 0,
      queuedAt: journal.cursor(),
      options: { model: 'default' },
      returned: { reason: 'old stored uncertainty', rejection: { kind: 'unconfirmed' } }
    })
    finishTestJournalHistoricalInputs(journal)
    await journal.queuedMessages.insert({ messageId: 'W', body: message('waiting') })
    const cards = readPublishedQueuedMessages(journal)
    expect(cards).toMatchObject([
      {
        messageId: 'recovery:original',
        state: 'waiting',
        paused: true,
        body: message('immutable full original')
      },
      { messageId: 'W', state: 'waiting' }
    ])
    expect(cards[1]).not.toHaveProperty('independentRecovery')
    expect(readPublishedQueuedMessages(journal)).toBe(cards)
    // A real move keeps the saved card’s source/body and own hold.
    await journal.queuedMessages.move({ messageId: 'recovery:original', afterMessageId: 'W' })
    const adopted = readPublishedQueuedMessages(journal)
    expect(adopted.find((c) => c.messageId === 'recovery:original')).toEqual({
      ...cards[0],
      position: adopted.find((c) => c.messageId === 'recovery:original')!.position
    })
    const publication = {
      queuedMessages: adopted,
      queuePause: { reason: 'stopped' } as const,
      nextQueuedMessageId: null
    }
    const events: AgentSessionSubscribeEvent[] = []
    const feed = new AgentSessionSubscribers({ readQueuePublication: () => publication })
    feed.open({
      id: 'bounded',
      sessionId,
      journal,
      fence: 0,
      boundedFrames: true,
      emit: (event) => events.push(event)
    })
    const snapshot = events.find((event) => event.type === 'snapshot')
    if (!snapshot || snapshot.type !== 'snapshot') {
      throw new Error('missing snapshot')
    }
    const hooks = { readQueuePublication: () => publication }
    const subscriber = { sessionId, boundedFrames: true }
    const batch: AgentSessionSubscribeEvent = {
      type: 'batch',
      sessionId,
      batch: { cursor: journal.cursor(), items: [], removedItemIds: [], submissions: [] }
    }
    const withheld = buildSubscriberFrame(hooks, subscriber, batch, true)
    expect(withheld.frames.every((e) => e.type === 'end' || e.queuedMessages === undefined)).toBe(
      true
    )
    const final = buildSubscriberFrame(hooks, subscriber, batch, false)
    const reset: AgentSessionSubscribeEvent = { ...snapshot, type: 'reset', reset: 'epoch_changed' }
    events.push(
      ...withheld.frames,
      ...final.frames,
      ...buildSubscriberFrame(hooks, subscriber, reset, false).frames
    )
    let desktop = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
      type: 'history-page',
      page: { ...snapshot.page, queuedMessages: adopted, queuePause: publication.queuePause }
    })
    // Desktop and phone now consume this same production reducer.
    for (const event of events) {
      desktop = reduceStructuredAgentSession(desktop, { type: 'event', event })
    }
    expect(desktop.queuedMessages).toEqual(adopted)
    expect(desktop.queuePause).toEqual(publication.queuePause)
    const projected = projectQueuedMessageCards(desktop.queuedMessages, desktop.submissions, {
      queuePaused: true
    })
    expect(projected.map((c) => c.hold)).toEqual(['queue-paused', 'paused'])
    expect(queuedMessagesQueuePause(projected, desktop.queuePause ?? null)).toEqual(
      publication.queuePause
    )
    await journal.queuedMessages.move({ messageId: 'recovery:original', beforeMessageId: 'W' })
    const heldBody = message('x'.repeat(Math.floor(BOUNDED_FRAME_CONTENT_BUDGET_BYTES / 3)))
    for (const messageId of ['P1', 'P2', 'P3']) {
      await journal.queuedMessages.insert({ messageId, body: heldBody, holdReason: 'send_failed' })
    }
    await journal.queuedMessages.move({ messageId: 'W', afterMessageId: 'P3' })
    const bounded = boundedQueuePublication({
      ...publication,
      queuedMessages: readPublishedQueuedMessages(journal)
    })
    expect(bounded.queuedMessages.map((c) => c.messageId)).toEqual([
      'recovery:original',
      'P1',
      'P2'
    ])
    expect(bounded.queuedMessages[0]).toMatchObject({
      messageId: 'recovery:original',
      state: 'waiting',
      paused: true,
      body
    })
    expect(bounded.queuedMessages.slice(1).map((c) => c.body)).toEqual([heldBody, heldBody])
    expect(
      queuedMessagesQueuePause(
        projectQueuedMessageCards(bounded.queuedMessages, [], {}),
        publication.queuePause
      )
    ).toBeNull()
  } finally {
    await journal.close()
  }
})
