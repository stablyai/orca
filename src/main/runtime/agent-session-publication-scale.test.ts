import { describe, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session-journal-types'
import * as journalReducer from '../native-chat/agent-session-journal/journal-reducer'
import type {
  AgentSessionStatusEvent,
  AgentSessionSubscribeEvent
} from '../../shared/agent-session-wire'
import { StructuredAgentSessionStatusFeed } from '../native-chat/agent-session-wire/structured-agent-session-status-feed'
import type { StatusFeedSession } from '../native-chat/agent-session-wire/structured-agent-session-status-feed-deps'
import type { StructuredAgentSessionHostSession } from '../native-chat/agent-session-wire/structured-agent-session-host-types'
import { AgentSessionSubscribers } from '../native-chat/agent-session-wire/structured-agent-session-subscribers'
import {
  readQueuePublication,
  structuredQueueSendGate
} from '../native-chat/agent-session-wire/structured-agent-session-queued-publication'
import { heldStructuredAgentSessionCurrentWork } from '../native-chat/agent-session-wire/structured-agent-session-host-current-work'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import { hostTestMessage } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import {
  openTestAgentSessionRecordStore,
  seedTestAgentSessionRecordStore
} from './agent-session-record-store-test-harness'
import {
  countStoreWork,
  scaleDirectory,
  scaleJournal,
  scaleRecord
} from './agent-session-scale.test-fixture'

// Publisher count, unrelated records, history and cards are independent dimensions.
describe('real-store status and queue publications', () => {
  it.each([
    [10, 10, 1, 1, 1],
    [100, 10, 1, 1, 1],
    [10, 100, 1, 1, 1],
    [10, 10, 10, 1, 1],
    [10, 10, 1, 10, 1],
    [10, 10, 1, 1, 10]
  ])(
    '%i publishers, %i inactive rows, %i history items, %i cards and %i submissions',
    async (n, inactive, history, cards, sends) => {
      const root = await scaleDirectory()
      const records = Array.from({ length: n }, (_, i) =>
        scaleRecord(`active-${String(i).padStart(5, '0')}`)
      )
      await seedTestAgentSessionRecordStore(root, {
        records: [
          ...records,
          ...Array.from({ length: inactive }, (_, i) => scaleRecord(`inactive-${i}`))
        ]
      })
      const store = await openTestAgentSessionRecordStore(root)
      const sessions = new Map<
        string,
        Pick<StatusFeedSession, 'journal' | 'params'> &
          Pick<
            StructuredAgentSessionHostSession,
            'child' | 'lastEndedChild' | 'operationalRevision'
          >
      >()
      const counts = {
        snapshots: 0,
        snapshotItems: 0,
        snapshotSubmissions: 0,
        submissions: 0,
        submissionRows: 0,
        itemReads: 0,
        lists: 0,
        listRows: 0,
        serializations: 0,
        serializedRows: 0
      }
      for (const row of records) {
        const journal = await scaleJournal(root, row.sessionId)
        for (let i = 0; i < history; i++) {
          await journal.appendItem(
            { provider: 'claude', sessionId: `provider-${row.sessionId}-0`, uuid: `item-${i}` },
            hostTestMessage(`saved-${i}`),
            { fence: 7, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
          )
        }
        for (let i = 0; i < cards; i++) {
          const card = {
            messageId: `card-${i}`,
            fingerprint: `fp-${i}`,
            hostInstance: 'scale-runtime',
            body: hostTestMessage(`draft-${i}`)
          }
          await journal.queuedMessages.insert(card)
        }
        for (let i = 0; i < sends; i++) {
          const clientMessageId = `send-${i}`
          await journal.appendSubmission({
            clientMessageId,
            payloadFingerprint: clientMessageId,
            body: hostTestMessage(`sent-${i}`),
            fence: 7
          })
          await journal.resolveDispatch({
            clientMessageId,
            state: 'accepted',
            providerIdentity: {
              provider: 'claude',
              sessionId: `provider-${row.sessionId}-0`,
              uuid: `send-${i}`
            },
            fence: 7
          })
        }
        expect(journal.submissions()).toHaveLength(sends)
        expect(
          journal.submissions().every((submission) => submission.dispatchState === 'accepted')
        ).toBe(true)
        sessions.set(row.sessionId, {
          journal,
          child: null,
          params: { location: row.location, provider: row.provider }
        })
        const submissions = journal.submissions
        vi.spyOn(journal, 'submissions').mockImplementation(() => {
          const value = submissions()
          counts.submissions++
          counts.submissionRows += value.length
          return value
        })
        const item = journal.item
        vi.spyOn(journal, 'item').mockImplementation((id) => {
          counts.itemReads++
          return item(id)
        })
        const list = journal.queuedMessages.list.bind(journal.queuedMessages)
        vi.spyOn(journal.queuedMessages, 'list').mockImplementation(() => {
          const value = list()
          counts.lists++
          counts.listRows += value.length
          return value
        })
      }
      const render = journalReducer.renderJournalState
      vi.spyOn(journalReducer, 'renderJournalState').mockImplementation((state) => {
        const value = render(state)
        counts.snapshots++
        counts.snapshotItems += value.items.length
        counts.snapshotSubmissions += value.submissions.length
        return value
      })
      const originalStringify = JSON.stringify
      vi.spyOn(JSON, 'stringify').mockImplementation((value, replacer, space) => {
        if (
          Array.isArray(value) &&
          value.length > 0 &&
          value.every((row) => typeof row === 'object' && row !== null && 'messageId' in row)
        ) {
          counts.serializations++
          counts.serializedRows += value.length
        }
        return originalStringify(value, replacer, space)
      })
      const work = countStoreWork(store)
      const statusEvents: AgentSessionStatusEvent[] = []
      const streamEvents: AgentSessionSubscribeEvent[] = []
      const feed = new StructuredAgentSessionStatusFeed({
        sessions,
        getConversation: store.getConversation,
        now: () => 1_800_000_000_000,
        logger: createStructuredAgentSessionLogger()
      })
      const subscribers = new AgentSessionSubscribers({
        onJournalPublished: (id, journal) => feed.publish(id, journal),
        readCurrentWork: (id, journal) =>
          heldStructuredAgentSessionCurrentWork(store, id, journal, sessions.get(id)),
        readQueuePublication: (id) => {
          const journal = sessions.get(id)?.journal
          return journal
            ? readQueuePublication(journal, structuredQueueSendGate({ store, sessions }, id))
            : undefined
        }
      })
      const disposeStatus = feed.subscribe({
        id: 'all-status',
        emit: (event) => statusEvents.push(event)
      })
      const disposers = records.map((row) =>
        subscribers.open({
          id: row.sessionId,
          sessionId: row.sessionId,
          journal: sessions.get(row.sessionId)!.journal,
          fence: 7,
          emit: (event) => streamEvents.push(event)
        })
      )
      expect(statusEvents[0]).toMatchObject({
        type: 'snapshot',
        sessions: expect.arrayContaining(
          records.map((row) => expect.objectContaining({ sessionId: row.sessionId }))
        )
      })
      expect(streamEvents.filter((event) => event.type === 'snapshot')).toHaveLength(n)
      expect(
        streamEvents
          .filter((event) => event.type === 'snapshot')
          .every((event) => 'queuedMessages' in event && event.queuedMessages?.length === cards)
      ).toBe(true)
      // Status projection, hydration and initial current-work restatement each read once.
      expect(counts.snapshots).toBe(3 * n)
      expect(counts.snapshotItems).toBe(3 * n * (history + sends))
      expect(counts.snapshotSubmissions).toBe(3 * n * sends)
      expect(counts.serializations).toBe(n)
      expect(counts.serializedRows).toBe(n * cards)
      const warm = { ...counts }
      work.reset()
      statusEvents.length = 0
      streamEvents.length = 0
      for (let event = 0; event < 3; event++) {
        for (const [id, session] of sessions) {
          subscribers.publish(id, session.journal)
        }
      }
      // Each publish derives queue pauses twice and checks current work independently.
      expect(counts).toEqual({
        ...warm,
        lists: warm.lists + 12 * n,
        listRows: warm.listRows + 12 * n * cards,
        submissions: warm.submissions + 12 * n,
        submissionRows: warm.submissionRows + 12 * n * sends
      })
      expect(work.counts).toMatchObject({ views: 9 * n, inventories: 0, clones: 0, decodes: 0 })
      expect(statusEvents).toEqual([])
      expect(streamEvents).toEqual([])
      const changed = records[0]!.sessionId
      await store.setConversationName(changed, 'Visible update')
      subscribers.publish(changed, sessions.get(changed)!.journal)
      expect(statusEvents).toMatchObject([
        { type: 'status', session: { sessionId: changed, conversationName: 'Visible update' } }
      ])
      const journal = sessions.get(changed)!.journal
      const card = {
        messageId: 'new-card',
        fingerprint: 'new',
        hostInstance: 'scale-runtime',
        body: hostTestMessage('new draft')
      }
      await journal.queuedMessages.insert(card)
      subscribers.publish(changed, journal)
      expect(counts.serializations).toBe(warm.serializations + 1)
      expect(
        streamEvents.some(
          (event) =>
            'queuedMessages' in event &&
            event.queuedMessages?.some((row) => row.messageId === 'new-card')
        )
      ).toBe(true)
      disposeStatus()
      disposers.forEach((dispose) => dispose())
      sessions.clear()
      const ended = [statusEvents.length, streamEvents.length]
      work.reset()
      subscribers.publish(changed, journal)
      expect([statusEvents.length, streamEvents.length]).toEqual(ended)
      expect(work.counts.views).toBe(0)
      expect(work.counts.inventories).toBe(0)
      expect(subscribers.subscriberCountForTests(changed)).toBe(0)
    }
  )
})
