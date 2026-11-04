import {
  appendTestJournalQueueRow,
  finishTestJournalHistoricalInputs
} from '../agent-session-journal/journal-host-database-test-support'
import { expect, it } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { agentSessionSendBodyFingerprint } from '../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session/agent-session-wire'
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
  db,
  message,
  historicalJournalFor
} from './structured-agent-session-queued-legacy-import.test-fixture'

it('carries saved independent holds through real publication, bounded snapshot/reset/catch-up/live and the shared reducer', async () => {
  const sessionId = 'historical-public-read'
  const journal = await historicalJournalFor(sessionId)
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
    await appendTestJournalQueueRow(await db(), journal, 'recovery:original', {
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
