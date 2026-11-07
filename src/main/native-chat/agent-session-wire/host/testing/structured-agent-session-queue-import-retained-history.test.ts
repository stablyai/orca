import { expect, it } from 'vitest'
import { agentJournalSubmissionKey } from '../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../../../../shared/agent-session/agent-session-wire'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from '../../../../../shared/agent-session/structured-agent-session-reducer'
import { AgentSessionSubscribers } from '../../publication/subscribers/structured-agent-session-subscribers'
import { readAgentSessionHistory } from '../../publication/history/agent-session-history-page'
import { subscriberHistoryReader } from '../../publication/history/agent-session-bounded-frames'
import type { AgentSessionJournal } from '../../../agent-session-journal/journal-store'
import { pinTestJournalInputMode } from '../../../agent-session-journal/replay/journal-historical-inputs.test-support'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'

import {
  db,
  handOff,
  journalFor,
  legacyIds,
  message,
  retainedHistoryCases,
  seedLegacy,
  threadWrite
} from './structured-agent-session-queue-import-contract-test-fixture'

it.each(['person', 'mail'] as const)(
  'accepted table-only %s handoff keeps its Stop provenance after cleanup and another open',
  async (sender) => {
    let journal = journalFor(SESSION)
    await journal.open()
    pinTestJournalInputMode(journal)
    await journal.appendStopEvent({ reason: 'user-stop' }, 0)
    await handOff(journal, 'H', 'S', 'sent', 'accepted')
    await journal.close()
    seedLegacy(SESSION, [
      ['W', 'waiting', 'waiting'],
      ['S', 'dispatched', 'sent', 'H']
    ])
    if (sender === 'mail') {
      const body = {
        ...message('sent'),
        from: {
          kind: 'agent',
          senders: [],
          orchestration: {
            message: 'mail-notice',
            mailbox: 'owner',
            dispatchId: null,
            messages: []
          }
        }
      }
      db()
        .prepare('UPDATE queued_messages SET body_json=? WHERE message_id=?')
        .run(JSON.stringify(body), 'S')
    }
    for (let opened = 0; opened < 2; opened++) {
      journal = journalFor(SESSION)
      await journal.open()
      await journal.queuedMessages.importAtOpen()
      expect(legacyIds()).toEqual([])
      expect(journal.queuedMessages.list().map((card) => card.messageId)).toEqual(['W'])
      expect(journal.queuedMessages.userStopInForce() === null).toBe(sender === 'person')
      await journal.appendSubmission({
        clientMessageId: `unattended-${opened}`,
        body: message('wake'),
        payloadFingerprint: 'wake',
        source: { kind: 'agent' },
        origin: 'host',
        handoverRecorded: true,
        fence: 0
      })
      await journal.resolveDispatch({
        clientMessageId: `unattended-${opened}`,
        state: 'accepted',
        providerIdentity: null,
        fence: 0
      })
      expect(journal.queuedMessages.nextInputCard()?.messageId ?? null).toBe(
        sender === 'person' ? 'W' : null
      )
      await journal.close()
    }
  }
)

it.each(retainedHistoryCases)('retained history: $adopt / $proof', async ({ adopt, proof }) => {
  const earlier = journalFor(SESSION)
  await earlier.open()
  const append = async (journal: AgentSessionJournal, ordinal: number) => {
    await journal.appendItem(
      { provider: 'codex', threadId: 'history', turnId: 't', ordinal },
      { ...message('x'.repeat(4_000)), role: 'assistant' },
      { fence: 0, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  }
  await append(earlier, 0)
  await handOff(
    earlier,
    'u',
    'q',
    'stopped words',
    'cancelled',
    0,
    async () => {
      for (let index = 1; index <= 205; index++) {
        await append(earlier, index)
      }
    },
    proof === 'none'
      ? undefined
      : {
          turn: { provider: 'codex', threadId: 'history', turnId: 't', ordinal: -1 },
          via: 'steer'
        }
  )
  const stale = readAgentSessionHistory(earlier, { sessionId: SESSION, direction: 'tail' })
  expect(stale.ok).toBe(true)
  await earlier.close()
  seedLegacy(SESSION, [['q', 'waiting', 'stopped words']])
  if (!adopt) {
    db().exec(`CREATE TEMP TRIGGER b2_fail_import BEFORE DELETE ON queued_messages
    BEGIN SELECT RAISE(ABORT, 'disk full'); END`)
  }
  const journal = journalFor(SESSION)
  await journal.open()
  if (!adopt) {
    db().exec('DROP TRIGGER b2_fail_import')
  }
  const queue = { queuedMessages: [], queuePause: null, nextQueuedMessageId: null }
  const feed = new AgentSessionSubscribers({ readQueuePublication: () => queue })
  const base = { sessionId: SESSION, journal, fence: 0 }
  const oldEvents: AgentSessionSubscribeEvent[] = []
  feed.open({
    ...base,
    id: 'old',
    cursor: journal.cursor(),
    snapshotCatchUp: false,
    readsCurrentRequests: false,
    emit: (event) => oldEvents.push(event)
  })
  expect(oldEvents).toEqual([
    {
      type: 'batch',
      sessionId: SESSION,
      fence: 0,
      hostNow: expect.any(Number),
      activity: null,
      ...queue,
      batch: { cursor: journal.cursor(), items: [], removedItemIds: [], submissions: [] }
    }
  ])
  const corrected: AgentSessionSubscribeEvent[][] = []
  const clients: (() => ReturnType<typeof reduceStructuredAgentSession>)[] = []
  for (const boundedFrames of [false, true]) {
    let state = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
      type: 'history-page',
      page: structuredClone(stale.page)
    })
    const events: AgentSessionSubscribeEvent[] = []
    corrected.push(events)
    clients.push(() => state)
    const reader = subscriberHistoryReader({ boundedFrames })
    feed.open({
      ...base,
      id: `new-${boundedFrames}`,
      cursor: journal.cursor(),
      boundedFrames,
      snapshotCatchUp: true,
      readsCurrentRequests: true,
      emit: (event) => {
        events.push(event)
        state = reduceStructuredAgentSession(state, {
          type: 'event',
          event: structuredClone(event)
        })
      }
    })
    expect(events[0]?.type).toBe('snapshot')
    while (state.hasOlder) {
      const requestedCursor = { epoch: journal.epoch, sequence: state.items[0]!.sequence }
      const older = readAgentSessionHistory(
        journal,
        { sessionId: SESSION, direction: 'before', cursor: requestedCursor },
        { reader }
      )
      expect(older.ok).toBe(true)
      state = reduceStructuredAgentSession(state, {
        type: 'older-page',
        requestedCursor,
        page: structuredClone(older.page)
      })
    }
    const canonical = journal.snapshot()
    expect([state.items, state.submissions]).toEqual([canonical.items, canonical.submissions])
    feed.publish(SESSION, journal)
    await append(journal, 205)
    feed.publish(SESSION, journal)
  }
  const cursor = journal.cursor()
  const after = readAgentSessionHistory(journal, {
    sessionId: SESSION,
    direction: 'after',
    cursor
  })
  expect(after).toMatchObject({ ok: false, reset: 'cursor_compacted' })
  if (!adopt) {
    await journal.queuedMessages.importAtOpen()
    feed.publish(SESSION, journal)
  }
  if (proof !== 'none') {
    const placed = journal
      .snapshot()
      .items.find((item) => item.itemId === agentJournalSubmissionKey('u'))
    const loaded = clients.map((client) => client().items.length)
    const normalizationKey = journal.publicRead().normalizationKey
    const identity = {
      provider: 'codex' as const,
      threadId: 'history',
      turnId: 't',
      ordinal: 206
    }
    if (proof === 'dispatch') {
      await journal.acceptLate({
        clientMessageId: 'u',
        state: 'accepted',
        fence: 0,
        providerIdentity: identity
      })
    }
    await journal.appendItem(identity, message('stopped words'), threadWrite)
    feed.publish(SESSION, journal)
    expect(journal.submission('u')?.dispatchState).toBe('accepted')
    expect(journal.receiptFor('u')).not.toBeNull()
    expect(journal.publicRead().normalizationKey).toBe(normalizationKey)
    expect(clients.map((client) => client().items.length)).toEqual(loaded)
    for (const client of clients) {
      expect(client().items.find((item) => item.itemId === placed?.itemId)).toMatchObject({
        sequence: placed?.sequence,
        observedAt: placed?.observedAt,
        turnScope: placed?.turnScope,
        revision: 1
      })
      expect(
        client().submissions.find((submission) => submission.clientMessageId === 'u')?.dispatchState
      ).toBe('accepted')
    }
  }
  expect(
    corrected.map((events) => events.filter((event) => event.type === 'snapshot').length)
  ).toEqual([1, 1])
  expect(oldEvents.every((event) => event.type === 'batch')).toBe(true)
  await journal.close()
  const reopened = journalFor(SESSION)
  await reopened.open()
  const resumed: AgentSessionSubscribeEvent[] = []
  new AgentSessionSubscribers().open({
    ...base,
    journal: reopened,
    id: 'reopen',
    cursor: reopened.cursor(),
    snapshotCatchUp: true,
    readsCurrentRequests: true,
    emit: (event) => resumed.push(event)
  })
  expect(resumed[0]?.type).toBe('snapshot')
  await reopened.close()
})
