import { expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { agentSessionConversationView } from '../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from '../../../shared/agent-session/view/live-read/structured-agent-session-reducer'
import { structuredAgentSessionSendingItemIds } from '../../../shared/agent-session/view/structured-agent-session-sending'
import { createStructuredAgentSessionPublicationWiring } from '../agent-session-wire/host/structured-agent-session-publication-wiring'
import { StructuredAgentSessionStatusFeed } from '../agent-session-wire/observations/structured-agent-session-status-feed'
import { AgentSessionSubscribers } from '../agent-session-wire/publication/subscribers/structured-agent-session-subscribers'
import {
  HOST_TEST_LOCATION,
  HOST_TEST_SESSION,
  HOST_TEST_THREAD,
  hostTestAttachParams,
  hostTestMessage
} from '../agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import { agentSessionRecordFixture } from '../testing/agent-session-record-test-fixture'
import type { JournalSqlDatabase } from './database/journal-sql-database'
import { readJournalDomainHistoryFrame } from './journal-domain-history-page'
import { migrateJournalDomainSchema } from './journal-domain-schema'
import { readJournalDomainSubmissionAttempt } from './journal-domain-submission-records'
import { JournalSqlCommand } from './journal-sql-command'
import { readJournalSqlPoint } from './journal-sql-point-read'
import { SqlAgentSessionJournal } from './journal-sql-store'
import type { JournalWriterCommand } from './journal-writer-command'

/** Use the real SQLite writer and reader procedures in this process to count both sides' decodes. */
function inProcessSql(db: Database.Database, now: () => number): JournalSqlDatabase {
  const target = { sessionId: HOST_TEST_SESSION, epoch: 'epoch', ownerToken: 'owner' }
  const cursor = { epoch: target.epoch, sequence: 10 }
  const writer = new JournalSqlCommand(db, '')
  migrateJournalDomainSchema(db)
  db.prepare(`INSERT INTO journal_chat_state(session_id,workspace_id,epoch,last_sequence,highest_fence)
    VALUES(?,?,?,?,1)`).run(
    target.sessionId,
    HOST_TEST_LOCATION.workspaceId,
    target.epoch,
    cursor.sequence
  )
  const port = {
    write: async (command: JournalWriterCommand) => {
      db.exec('BEGIN IMMEDIATE')
      try {
        const commit = await writer.apply(command, now())
        db.exec('COMMIT')
        return commit
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    }
  }
  const database = {
    openSession: async () => ({
      target,
      commit: {
        cursor,
        value: cursor,
        inputChanged: false,
        keys: [],
        items: [],
        inputKeys: [],
        effects: []
      }
    }),
    readers: {
      point: async (request: Parameters<typeof readJournalSqlPoint>[1]) =>
        readJournalSqlPoint(db, request),
      domainHistoryFrame: async (
        request: Parameters<typeof readJournalDomainHistoryFrame>[1],
        work: Parameters<typeof readJournalDomainHistoryFrame>[2]
      ) => readJournalDomainHistoryFrame(db, request, work)
    },
    sending: { urgency: () => ({}) },
    serialize: <T>(_: string, run: (value: typeof port) => Promise<T>) => run(port)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The test replaces every database port the live journal uses here.
  return database as unknown as JournalSqlDatabase
}

// PR #45057: a provider receipt used to decode the unchanged prompt on its writer and status reader.
it.each([64, 640])(
  'records and delivers a receipt without decoding the %i KiB prompt',
  async (sizeKiB) => {
    const db = new Database(':memory:')
    const time = 1_800_000_000_000
    let at = time
    const now = () => at
    const sessionId = HOST_TEST_SESSION
    const id = 'send'
    const handle = codexProviderHandle(HOST_TEST_THREAD)
    const marker = 'receipt-performance-prompt'
    const body = hostTestMessage(marker.padEnd(sizeKiB * 1024, 'x'))
    const dispatch = { clientMessageId: id, fence: 1, turnScope: { kind: 'thread' as const } }
    try {
      const journal = await SqlAgentSessionJournal.open({
        database: inProcessSql(db, now),
        identity: {
          sessionId,
          workspaceId: HOST_TEST_LOCATION.workspaceId,
          hostId: 'local',
          agent: 'codex',
          providerHandle: handle
        },
        now
      })
      await journal.write({
        kind: 'submission',
        input: {
          clientMessageId: id,
          body,
          payloadFingerprint: 'prompt',
          fence: 1,
          origin: 'client',
          source: { kind: 'user' },
          handoverRecorded: true
        }
      })
      at += 1
      const pending = await journal.write({
        kind: 'dispatch',
        input: { ...dispatch, state: 'pending' }
      })

      let publication: void | Promise<void> = undefined
      const journalPublished = vi.fn()
      const subscribers = new AgentSessionSubscribers({
        readWorkFrame: (...args) => feed.journalProjection.workFrame(...args),
        onJournalPublished: journalPublished,
        now
      })
      const deliverFrames = vi.spyOn(subscribers, 'deliverFrames')
      const observe = vi.fn()
      const observeRows = vi.fn()
      const afterCommit = vi.fn()
      const afterSettleEdge = vi.fn()
      const workChanged = vi.fn()
      const client = {
        requestFailures: { observe, forget: () => {} },
        subscribers,
        publishJournal: vi.fn(() => {
          journalPublished()
          publication = feed.publish(sessionId, journal)
        })
      }
      const logger = { warn: vi.fn(), error: vi.fn() }
      const sessions = createStructuredAgentSessionPublicationWiring({
        client: () => client,
        delivery: () => ({ afterCommit, afterSettleEdge }),
        logger: () => logger,
        opened: () => {},
        workChanged,
        now,
        observeRows: () => observeRows
      })
      const backing = agentSessionRecordFixture({
        sessionId,
        provider: 'codex',
        providerHandleChain: [
          { handle, linkId: 'link', origin: 'created', mintedAtFence: 1, observedAt: at }
        ]
      })
      const record = agentSessionConversationView({
        ...backing,
        lease: { ...backing.lease, claimStatus: 'live' }
      })
      const feed = new StructuredAgentSessionStatusFeed({
        sessions,
        getConversation: () => record,
        now,
        logger
      })
      sessions.set(sessionId, {
        journal,
        params: hostTestAttachParams(1),
        child: { fence: 1, generation: 'child', phase: 'ready', heldSends: () => new Set([id]) }
      })
      await feed.publish(sessionId, journal)
      const before = await feed.journalProjection(sessionId, journal)
      expect(before?.state.summary.latestPrompt).toContain(marker)
      expect(before?.work?.restatedSubmissions).toMatchObject([
        { clientMessageId: id, dispatchState: 'pending' }
      ])

      let state = EMPTY_STRUCTURED_AGENT_SESSION
      const end = vi.fn()
      const publications = vi.fn()
      const settled = vi.fn()
      const stopPublications = sessions.observeConversationPublications(sessionId, {
        next: publications,
        error: end
      })
      const stopSettled = sessions.observeSettledTurns(sessionId, journal, settled)
      const emit = vi.fn(
        (event: Parameters<typeof reduceStructuredAgentSession>[1] & { type: 'event' }) => {
          state = reduceStructuredAgentSession(state, event, now())
        }
      )
      const close = subscribers.open({
        id: 'reader',
        sessionId,
        journal,
        fence: 1,
        readsProviderReceipts: true,
        end,
        emit: (event) => emit({ type: 'event', event })
      })
      const sending = () =>
        structuredAgentSessionSendingItemIds([], state.submissions, state.writtenAtById)
      await vi.waitFor(() => {
        if (end.mock.calls.length) {
          throw end.mock.calls[0]![0]
        }
        expect(state.submissions).toMatchObject([{ clientMessageId: id, dispatchState: 'pending' }])
      })
      expect(sending()).toEqual(new Set(['orca:send']))
      const excluded = [
        client.publishJournal,
        journalPublished,
        observe,
        observeRows,
        afterCommit,
        afterSettleEdge,
        workChanged,
        publications,
        settled
      ]
      for (const observer of excluded) {
        observer.mockClear()
      }
      emit.mockClear()
      const parse = vi.spyOn(JSON, 'parse')
      const promptDecodes = () => parse.mock.calls.filter(([text]) => text.includes(marker)).length
      try {
        at += 2
        const receipt = await journal.write({
          kind: 'dispatch-written',
          clientMessageId: id,
          fence: 1,
          providerReceipt: true,
          observedAt: at
        })
        await publication
        await vi.waitFor(() => expect(state.cursor).toEqual(receipt.cursor))
        expect(emit).toHaveBeenCalledExactlyOnceWith({
          type: 'event',
          event: expect.objectContaining({
            type: 'batch',
            batch: {
              cursor: receipt.cursor,
              items: [],
              removedItemIds: [],
              submissions: [expect.objectContaining({ clientMessageId: id, writtenAt: at })]
            }
          })
        })
        expect(state.writtenAtById.get(id)).toBe(at)
        expect(sending().size).toBe(0)
        expect(promptDecodes()).toBe(0)
        for (const observer of excluded) {
          expect(observer).not.toHaveBeenCalled()
        }
        expect(sessions.lastActivityAt(sessionId)).toBe(at)
        expect(deliverFrames).toHaveBeenCalledOnce()
        expect(deliverFrames.mock.calls[0]?.at(-1)).toEqual(pending.cursor)
        expect(receipt).toMatchObject({
          cursor: { epoch: pending.cursor.epoch, sequence: pending.cursor.sequence + 1 },
          inputChanged: false,
          requestEvents: [],
          publication: { writtenOnly: true, items: [] }
        })
        const current = await feed.journalProjection(sessionId, journal)
        expect(promptDecodes()).toBe(0)

        // Reopening at the head owes a work restatement, but has no catch-up page to decorate.
        const resumed = vi.fn()
        const stopResumed = subscribers.open({
          id: 'resumed',
          sessionId,
          journal,
          fence: 1,
          cursor: receipt.cursor,
          readsProviderReceipts: true,
          emit: resumed,
          end
        })
        try {
          await vi.waitFor(() =>
            expect(resumed).toHaveBeenCalledWith(
              expect.objectContaining({
                type: 'batch',
                batch: expect.objectContaining({
                  cursor: receipt.cursor,
                  submissions: [expect.objectContaining({ clientMessageId: id, writtenAt: at })]
                })
              })
            )
          )
          expect(promptDecodes()).toBe(0)
        } finally {
          stopResumed()
        }
        expect(current).toMatchObject({
          ...receipt.cursor,
          lastActivityAt: at,
          state: before?.state
        })
        expect(
          readJournalDomainSubmissionAttempt(db, { sessionId, epoch: 'epoch' }, id, false)
            ?.submission
        ).toMatchObject({ dispatchState: 'pending', writtenAt: at })
        expect(promptDecodes()).toBe(0)

        at += 1
        const redispatched = await journal.write({
          kind: 'dispatch',
          input: { ...dispatch, state: 'pending' }
        })
        await vi.waitFor(() => expect(state.cursor).toEqual(redispatched.cursor))
        expect(state.writtenAtById.get(id)).toBeUndefined()
        expect(sending()).toEqual(new Set(['orca:send']))

        at += 1
        await journal.write({
          kind: 'dispatch',
          input: { clientMessageId: id, fence: 1, state: 'accepted', providerIdentity: null }
        })
        await publication
        const accepted = await feed.journalProjection(sessionId, journal)
        expect(promptDecodes()).toBeGreaterThan(0)
        expect(accepted?.acceptedSendKey).not.toBe(before?.acceptedSendKey)
        expect(logger.warn).not.toHaveBeenCalled()
      } finally {
        parse.mockRestore()
        close()
        stopPublications()
        stopSettled()
      }
    } finally {
      db.close()
    }
  }
)
