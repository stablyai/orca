import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import {
  openTestJournalHostDatabase,
  closeTestJournalHostDatabase
} from './journal-host-database-test-support'
import { publishNewEpoch } from './journal-epoch-rollover'
import { openAgentSessionJournal } from './journal-store-factory'
import { JournalOutcomeCompaction } from './journal-outcome-compaction-test-support'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import {
  AGENT_JOURNAL_THREAD_SCOPE as thread,
  type AgentJournalMessageItem
} from '../../../shared/agent-session-journal-types'
import { agentSessionSendBodyFingerprint as fingerprint } from '../../../shared/structured-agent-session-send-mutation'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import {
  queuedImageReaderSnapshot,
  queuedImageSourceIds
} from '../agent-session-wire/agent-session-queued-image-reader'
import { readPublishedQueuedMessages } from '../agent-session-wire/structured-agent-session-queued-publication'
import {
  projectQueuedImageCardPublication,
  queuedImageHistoryReader,
  queuedImageSubscriber
} from '../../runtime/rpc/methods/structured-agent-session-queued-image-capability'
import { openStructuredAgentSessionConversationJournal } from '../agent-session-wire/structured-agent-session-conversation-open'
import { agentSessionRecordFixture } from '../agent-session-record-test-fixture'
import { agentSessionConversationView } from '../../../shared/agent-session-conversation-view'

export function registerRetainedOutcomeContract() {
  it('retained-facts-next-action compacts real prefix0 outcomes and reopens actual image/action/echo consumers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-pr-32267-retained-'))
    let journal: Awaited<ReturnType<typeof openAgentSessionJournal>> | undefined
    try {
      const sessionId = 'retained-session'
      const identity = {
        sessionId,
        workspaceId: 'ws',
        hostId: 'local',
        agent: 'codex' as const,
        providerHandle: codexProviderHandle('thread-1')
      }
      let database = openTestJournalHostDatabase(root)
      let time = 10000
      publishNewEpoch({
        database,
        identity,
        epoch: 'retained-epoch',
        reason: 'session_created',
        fence: 1,
        now: time++,
        expectedEpoch: null,
        queue: { cards: [], receipt: { write: () => {}, committed: () => {} } },
        onPublished: () => {}
      })
      journal = await openAgentSessionJournal({ identity, database, now: () => time++ })
      const original: AgentJournalMessageItem = {
        kind: 'message',
        role: 'user',
        blocks: [
          { type: 'text', text: 'original U' },
          { type: 'image-ref', path: '/qa/original.png' }
        ]
      }
      const edited: AgentJournalMessageItem = {
        ...original,
        blocks: [
          { type: 'text', text: 'independent Q' },
          { type: 'image-ref', path: '/qa/edited.png' }
        ]
      }
      const rejection = (kind: 'unconfirmed' | 'providerRejected') =>
        agentSessionFailureWords(agentSessionFailureFact(kind), { surface: 'rejection' })
      await journal.appendSubmission({
        clientMessageId: 'U',
        body: original,
        payloadFingerprint: fingerprint(sessionId, original),
        fence: 1,
        queuedMessageId: 'Q',
        handoverRecorded: true,
        options: { model: 'original-model', effort: 'medium' }
      })
      await journal.resolveDispatch({
        clientMessageId: 'U',
        state: 'pending',
        turnScope: thread,
        fence: 1
      })
      await journal.resolveDispatch({
        clientMessageId: 'U',
        state: 'rejected',
        fence: 1,
        ...rejection('unconfirmed')
      })
      expect(journal.presentationRemoved('orca:U')).toBe(true)
      await journal.close()
      journal = await openAgentSessionJournal({ identity, database, now: () => time++ })
      expect(journal.presentationRemoved('orca:U')).toBe(true)
      database.db
        .prepare(
          `INSERT INTO queued_messages (session_id,message_id,position,body_json,fingerprint,created_at,host_instance,state,options_json) VALUES (?,?,1,?,?,0,'earlier','waiting',?)`
        )
        .run(
          sessionId,
          'Q',
          JSON.stringify(edited),
          fingerprint(sessionId, edited),
          JSON.stringify({ model: 'edited-model', effort: 'high' })
        )
      await journal.close()
      journal = await openAgentSessionJournal({ identity, database, now: () => time++ })
      expect(database.db.prepare('SELECT message_id FROM queued_messages').all()).toEqual([])
      expect(journal.queuedMessages.get('Q')).toMatchObject({
        recovers: 'U',
        state: 'waiting',
        body: edited
      })
      expect(queuedImageSourceIds(journal, 'Q')).toEqual(['Q', 'U'])
      const first = structuredClone(journal.queuedMessages.get('Q'))
      await journal.appendSubmission(
        {
          clientMessageId: 'V',
          body: edited,
          payloadFingerprint: fingerprint(sessionId, edited),
          fence: 1,
          origin: 'client',
          handoverRecorded: true,
          options: first?.options
        },
        { messageId: 'Q', expect: 'waiting' }
      )
      await journal.resolveDispatch({
        clientMessageId: 'V',
        state: 'pending',
        turnScope: thread,
        fence: 1
      })
      await journal.resolveDispatch({
        clientMessageId: 'V',
        state: 'rejected',
        fence: 1,
        ...rejection('providerRejected')
      })
      const returned = structuredClone(journal.queuedMessages.get('Q'))
      expect(returned).toMatchObject({
        state: 'returned',
        recovers: 'U',
        consumedAs: 'V',
        body: edited
      })
      await journal.acceptLate({
        clientMessageId: 'U',
        state: 'accepted',
        fence: 1,
        providerIdentity: { provider: 'codex', threadId: 'thread-1', turnId: 'late-U', ordinal: 0 }
      })
      const receipt = structuredClone(journal.receiptFor('U'))
      expect(journal.queuedMessages.get('Q')).toEqual(returned)
      // A distinct genuine handed-over pending send makes production recovery nonempty.
      const pending: AgentJournalMessageItem = {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: 'pending control' }]
      }
      await journal.appendSubmission({
        clientMessageId: 'P',
        body: pending,
        payloadFingerprint: fingerprint(sessionId, pending),
        fence: 1,
        handoverRecorded: true
      })
      await journal.resolveDispatch({
        clientMessageId: 'P',
        state: 'pending',
        turnScope: thread,
        fence: 1
      })
      const normalization = [...journal.queuedMessages.displayState().normalizedHandOffs]
      const before = {
        snapshot: queuedImageReaderSnapshot(journal),
        sources: queuedImageSourceIds(journal, 'Q'),
        card: journal.queuedMessages.get('Q'),
        body: journal.submissionBody('U'),
        removed: journal.presentationRemoved('orca:U')
      }
      expect(before.sources).toEqual(['Q', 'U', 'V'])
      const raw = database.db.prepare('SELECT seq,row_json FROM journal_rows ORDER BY seq').all()
      expect(raw).toHaveLength(1)
      expect(JSON.parse(String(raw[0].row_json))).toMatchObject({ v: 5 })
      expect(
        database.db.prepare('SELECT prefix_seq,format FROM journal_outcome_epochs').all()
      ).toEqual([{ prefix_seq: 0, format: 1 }])
      const inventory = () =>
        database.db
          .prepare(
            'SELECT generation,seq,field,entry_key,format,ordinal,value_json,deleted FROM journal_outcomes ORDER BY generation,seq,field,entry_key'
          )
          .all()
      const all = inventory()
      expect(all.every((row) => !String(row.field).startsWith('inputs.'))).toBe(true)
      expect(
        all
          .filter((row) => row.field === 'queue.cards')
          .every((row) => !String(row.value_json).includes('recovers'))
      ).toBe(true)
      const compactor = new JournalOutcomeCompaction()
      while (compactor.page(database)) {}
      const retained = inventory()
      expect(retained.length).toBeLessThan(all.length)
      await journal.close()
      journal = undefined
      await closeTestJournalHostDatabase(root)
      database = openTestJournalHostDatabase(root)
      const record = agentSessionConversationView(
        agentSessionRecordFixture({
          sessionId,
          provider: 'codex',
          accountHome: { variable: 'CODEX_HOME', path: '/qa/codex' },
          providerHandleChain: [
            {
              origin: 'created',
              linkId: 'link-1',
              mintedAtFence: 1,
              observedAt: 1,
              handle: codexProviderHandle('thread-1')
            }
          ],
          location: { workspaceId: 'ws', executionHostId: 'local' }
        })
      )
      const warnings: unknown[] = []
      const reopened = await openStructuredAgentSessionConversationJournal(
        {
          journalDatabase: database,
          logger: {
            warn: (...args) => {
              warnings.push(args)
            },
            info: () => {},
            error: () => {},
            debug: () => {}
          }
        },
        record,
        { acquisition: true }
      )
      journal = reopened.session.journal
      expect(warnings).toEqual([])
      expect(journal.submission('P')).toMatchObject({ dispatchState: 'unknown', recovered: true })
      expect(journal.queuedMessages.displayState().inputs.candidates.get('P')).toBe(
        journal.queuedMessages.displayState().submissions.get('P')
      )
      expect([...journal.queuedMessages.displayState().normalizedHandOffs]).toEqual(normalization)
      expect(journal.submissionBody('U')).toEqual(original)
      expect(journal.submissionBody('V')).toEqual(edited)
      expect(journal.queuedMessages.get('Q')).toEqual(returned)
      expect(journal.presentationRemoved('orca:U')).toBe(false)
      expect(queuedImageSourceIds(journal, 'Q')).toEqual(before.sources)
      const after = queuedImageReaderSnapshot(journal)
      expect(after.items).toEqual(before.snapshot.items)
      expect(after.submissions.filter((s) => s.clientMessageId !== 'P')).toEqual(
        before.snapshot.submissions.filter((s) => s.clientMessageId !== 'P')
      )
      const publication = {
        queuedMessages: readPublishedQueuedMessages(journal),
        queuePause: null,
        nextQueuedMessageId: null
      }
      const old = { clientKind: 'mobile' as const, clientCapabilities: [] }
      expect(queuedImageHistoryReader(old)?.queueSourceIds?.(journal, 'Q')).toEqual(['Q', 'U', 'V'])
      expect(queuedImageSubscriber(old).readHistorySnapshot?.(journal)).toEqual(after)
      expect(
        projectQueuedImageCardPublication(publication, old).queuedMessages[0].body
      ).toMatchObject({
        command: { name: 'compact' },
        blocks: [{ type: 'text', text: 'independent Q\n/qa/edited.png' }]
      })
      expect(projectQueuedImageCardPublication(publication, { clientKind: undefined })).toBe(
        publication
      )
      await journal.appendItem(
        { provider: 'codex', threadId: 'thread-1', turnId: 'next-equal', ordinal: 0 },
        original,
        { fence: 1, turnScope: thread }
      )
      expect(journal.queuedMessages.displayState().aliases.get('codex:thread-1:next-equal:0')).toBe(
        'orca:U'
      )
      expect(journal.receiptFor('U')).toEqual(receipt)
      expect(journal.queuedMessages.get('Q')).toEqual(returned)
      const echoCompactor = new JournalOutcomeCompaction()
      while (echoCompactor.page(database)) {}
      const keptEcho = inventory()
      expect(keptEcho).not.toEqual(retained)
      await journal.close()
      journal = undefined
      await closeTestJournalHostDatabase(root)
      database = openTestJournalHostDatabase(root)
      journal = (
        await openStructuredAgentSessionConversationJournal(
          {
            journalDatabase: database,
            logger: {
              warn: (...args) => {
                warnings.push(args)
              },
              info: () => {},
              error: () => {},
              debug: () => {}
            }
          },
          record,
          { acquisition: true }
        )
      ).session.journal
      await journal.appendItem(
        { provider: 'codex', threadId: 'thread-1', turnId: 'next-after-participation', ordinal: 0 },
        original,
        { fence: 1, turnScope: thread }
      )
      expect(
        journal.queuedMessages
          .displayState()
          .aliases.has('codex:thread-1:next-after-participation:0')
      ).toBe(false)
      expect(journal.queuedMessages.displayState().inputs.echoes.has('orca:U')).toBe(true)
      expect(journal.item('codex:thread-1:next-after-participation:0')?.body).toEqual(original)
      expect(journal.receiptFor('U')).toEqual(receipt)
      const card = journal.queuedMessages.get('Q')
      if (!card) {
        throw new Error('owed Q missing')
      }
      await journal.appendSubmission(
        {
          clientMessageId: 'W',
          body: card.body,
          payloadFingerprint: card.fingerprint,
          fence: 1,
          origin: 'client',
          handoverRecorded: true,
          options: card.options
        },
        { messageId: 'Q', expect: 'returned' }
      )
      expect(journal.submissionBody('W')).toEqual(edited)
      expect(journal.submission('W')?.options).toEqual({ model: 'edited-model', effort: 'high' })
      await journal.resolveDispatch({
        clientMessageId: 'W',
        state: 'pending',
        turnScope: thread,
        fence: 1
      })
      await journal.resolveDispatch({
        clientMessageId: 'W',
        state: 'rejected',
        fence: 1,
        ...rejection('providerRejected')
      })
      await journal.queuedMessages.withdraw(['Q'])
      const selectedAfterRemoval = journal.presentationRemoved('orca:U')
      expect(selectedAfterRemoval).toBe(false)
      const removalCompactor = new JournalOutcomeCompaction()
      while (removalCompactor.page(database)) {}
      await journal.close()
      journal = undefined
      await closeTestJournalHostDatabase(root)
      database = openTestJournalHostDatabase(root)
      journal = (
        await openStructuredAgentSessionConversationJournal(
          {
            journalDatabase: database,
            logger: {
              warn: (...args) => {
                warnings.push(args)
              },
              info: () => {},
              error: () => {},
              debug: () => {}
            }
          },
          record,
          { acquisition: true }
        )
      ).session.journal
      expect(journal.queuedMessages.get('Q')?.state).toBe('withdrawn')
      expect(journal.presentationRemoved('orca:U')).toBe(selectedAfterRemoval)
      expect(journal.submissionBody('W')).toEqual(edited)
    } finally {
      await journal?.close()
      await closeTestJournalHostDatabase(root)
      await rm(root, { recursive: true, force: true })
    }
  })
}

export function registerRetainedEchoBoundaryContract() {
  it('restores first implicit participation through compaction and a production kept-row rewind before an equal next send', async () => {
    const results: {
      implicit: boolean
      rewind: boolean
      reopened: boolean
      alias: string
      state: string | undefined
      receipt: unknown
    }[] = []
    for (const implicit of [true, false]) {
      for (const rewind of [false, true]) {
        for (const reopened of [false, true]) {
          const root = await mkdtemp(join(tmpdir(), 'orca-pr-32267-implicit-'))
          let journal: Awaited<ReturnType<typeof openAgentSessionJournal>> | undefined
          try {
            let time = 10000
            const identity = {
              sessionId: 'implicit-session',
              workspaceId: 'ws',
              hostId: 'local',
              agent: 'codex' as const,
              providerHandle: codexProviderHandle('thread-1')
            }
            let database = openTestJournalHostDatabase(root)
            publishNewEpoch({
              database,
              identity,
              epoch: 'implicit-epoch',
              reason: 'session_created',
              fence: 1,
              now: time++,
              expectedEpoch: null,
              queue: { cards: [], receipt: { write: () => {}, committed: () => {} } },
              onPublished: () => {}
            })
            journal = await openAgentSessionJournal({ identity, database, now: () => time++ })
            const body: AgentJournalMessageItem = {
              kind: 'message',
              role: 'user',
              blocks: [{ type: 'text', text: 'same words' }]
            }
            const provider = {
              provider: 'codex' as const,
              threadId: 'thread-1',
              turnId: 'one',
              ordinal: 1
            }
            const { agentJournalItemKey } =
              await import('../../../shared/agent-session-journal-item-key')
            await journal.appendSubmission({
              clientMessageId: 'U',
              body,
              payloadFingerprint: fingerprint(identity.sessionId, body),
              fence: 1,
              handoverRecorded: true
            })
            await journal.resolveDispatch({
              clientMessageId: 'U',
              state: 'pending',
              fence: 1,
              turnScope: thread
            })
            await (implicit
              ? journal.appendItem(provider, body, { fence: 1, turnScope: thread })
              : journal.resolveDispatch({
                  clientMessageId: 'U',
                  state: 'accepted',
                  providerIdentity: provider,
                  fence: 1
                }))
            let receipt = journal.receiptFor('U')
            expect(receipt?.providerItemId).toBe(agentJournalItemKey(provider))
            expect(journal.submission('U')?.dispatchState).toBe('accepted')
            expect(journal.queuedMessages.displayState().inputs.echoes.has('orca:U')).toBe(implicit)
            if (rewind) {
              const target = { ...provider, turnId: 'remove' }
              await journal.appendItem(
                target,
                { ...body, blocks: [{ type: 'text', text: 'remove this turn' }] },
                { fence: 1, turnScope: thread }
              )
              const { structuredRewindCut } =
                await import('../agent-session-wire/structured-rewind-cut')
              const cut = structuredRewindCut(journal, {
                itemId: agentJournalItemKey(target),
                provider: 'codex',
                nativeId: 'thread-1'
              })
              expect(cut?.kept.map((row) => agentJournalItemKey(row.identity))).toEqual(['orca:U'])
              const { seedTestAgentSessionRecordStore, openTestAgentSessionRecordStore } =
                await import('../../runtime/agent-session-record-store-test-harness')
              const pending = {
                operationId: 'rewind',
                callerKey: 'desktop',
                itemId: agentJournalItemKey(target),
                expectedEpoch: journal.cursor().epoch,
                phase: 'provider-succeeded' as const
              }
              await seedTestAgentSessionRecordStore(root, {
                records: [
                  agentSessionRecordFixture({
                    sessionId: identity.sessionId,
                    provider: 'codex',
                    providerHandleChain: [
                      {
                        origin: 'created',
                        linkId: 'link',
                        mintedAtFence: 1,
                        observedAt: time++,
                        handle: identity.providerHandle
                      }
                    ],
                    rewind: pending
                  })
                ]
              })
              const store = await openTestAgentSessionRecordStore(root)
              const { applyStructuredRewindRecovery } =
                await import('../agent-session-wire/structured-rewind-recovery')
              const { createStructuredAgentSessionLogger } =
                await import('../agent-session-wire/structured-agent-session-logger')
              await applyStructuredRewindRecovery(
                { store, logger: createStructuredAgentSessionLogger() },
                identity.sessionId,
                journal,
                1,
                { rewind: pending }
              )
              expect(store.getRecord(identity.sessionId)?.rewind?.phase).toBe('completed')
              expect(journal.item('orca:U')?.body).toEqual(body)
              expect(journal.item(agentJournalItemKey(target))).toBeNull()
              expect(journal.receiptFor('U')).toEqual({
                ...receipt,
                cursor: { ...receipt!.cursor, epoch: journal.cursor().epoch }
              })
              receipt = journal.receiptFor('U')
            }
            const compactor = new JournalOutcomeCompaction()
            while (compactor.page(database)) {}
            if (reopened) {
              await journal.close()
              journal = undefined
              await closeTestJournalHostDatabase(root)
              database = openTestJournalHostDatabase(root)
              journal = await openAgentSessionJournal({ identity, database, now: () => time++ })
            }
            await journal.appendSubmission({
              clientMessageId: 'V',
              body,
              payloadFingerprint: fingerprint(identity.sessionId, body),
              fence: 1,
              handoverRecorded: true
            })
            await journal.resolveDispatch({
              clientMessageId: 'V',
              state: 'pending',
              fence: 1,
              turnScope: thread
            })
            const next = { ...provider, turnId: 'next' }
            await journal.appendItem(next, body, { fence: 1, turnScope: thread })
            results.push({
              implicit,
              rewind,
              reopened,
              alias: journal.canonicalItemId(agentJournalItemKey(next)),
              state: journal.submission('V')?.dispatchState,
              receipt: journal.receiptFor('V')
            })
            expect(journal.receiptFor('U')).toEqual(receipt)
            expect(
              journal
                .snapshot()
                .items.filter((item) => item.body.kind === 'message' && item.body.role === 'user')
                .map((item) => item.itemId)
            ).toEqual(['orca:U', 'orca:V'])
          } finally {
            await journal?.close()
            await closeTestJournalHostDatabase(root)
            await rm(root, { recursive: true, force: true })
          }
        }
      }
    }
    for (const result of results) {
      expect(result.alias).toBe(result.implicit ? 'orca:V' : 'orca:U')
      expect(result.state).toBe(result.implicit ? 'accepted' : 'pending')
      if (result.implicit) {
        expect(result.receipt).toMatchObject({
          clientMessageId: 'V',
          providerItemId: 'codex:thread-1:next:1'
        })
      } else {
        expect(result.receipt).toBeNull()
      }
    }
  })
}
