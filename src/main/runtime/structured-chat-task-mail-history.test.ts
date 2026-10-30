import './rpc/unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session-journal-types'
import { formatOrcaSessionAddress } from '../../shared/orca-session-address'
import { testOrcaSessionId } from '../../shared/orca-session-address-test-fixture'
import { createRootDispatch } from './orchestration/db/root-dispatch-test-fixture'
import { dispatchTaskSource } from './orchestration/dispatch-task-source'
import {
  observeMailHistoryWork,
  observeMailSqlWork
} from './orchestration/mail-sql-work.test-support'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import { MAIL_CALLER } from './orchestration/structured-mail-operation-identity'
import { ordinaryMailCreationId } from './orchestration/structured-mailbox-pointer-delivery'
import { originalMailHistory } from './orchestration/structured-mail-original-history'
import { readMailCreationHistory } from './orchestration/structured-mail-creation-history'
import {
  hostTestMessage,
  hostTestOperationId
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { structuredMailSource } from './orchestration/structured-mail-source'
import { sendAgentTurn } from './orchestration/send-agent-turn'
import { sendChatTask } from './rpc/methods/orchestration/chat-task-delivery'
import { attachParams } from './structured-chat-coordinator-fake-codex-fixture'
import {
  COORDINATOR,
  PEER_CHAT,
  WAIT,
  coordinatorRunAndTask,
  db,
  host,
  observationClock,
  openChat,
  sendUserMessage,
  settleTurn
} from './structured-chat-coordinator-mail-rig.test-fixture'

it.each([100, 1000])(
  'real busy chat-task commits avoid retained-history scans at N=%i and drain through ordinary full turns',
  async (count) => {
    await openChat(COORDINATOR)
    const worker = await openChat(PEER_CHAT)
    const { runId } = await coordinatorRunAndTask()
    expect(await sendUserMessage(PEER_CHAT, 'current work before the new tasks')).toMatchObject({
      ok: true
    })
    await vi.waitFor(() => expect(worker.turns).toHaveLength(1), WAIT)
    const journal = host.collaboratorsForTests().sessions.get(PEER_CHAT)!.journal
    for (let n = 0; n < count; n++) {
      await journal.appendItem(
        { provider: 'orca', clientMessageId: `populated-X-${n}` },
        { kind: 'status', text: `retained preamble history ${n}` },
        {
          fence: host.deps.store.getRecord(PEER_CHAT)!.lease.runtimeFence,
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        }
      )
    }
    const retained = db.insertMessages(
      Array.from({ length: count }, (_, n) => ({
        id: `retained-member-${n}`,
        runId,
        from: 'old-worker',
        to: 'retained-legacy',
        subject: 'old accepted member'
      }))
    )
    db.markAsRead(retained.map((source) => source.id))
    const from = structuredMailSource({
      db,
      mailboxHandle: 'retained-legacy',
      dispatchId: null,
      message: retained[0]!,
      senderName: () => null
    })
    if (from.orchestration?.message !== 'mail-notice') {
      throw new Error('missing original batch attribution')
    }
    expect(await sendUserMessage(COORDINATOR, 'current coordinator work')).toMatchObject({
      ok: true
    })
    expect(
      await sendAgentTurn({
        kind: 'structured-session',
        host,
        sessionId: COORDINATOR,
        callerKey: 'trusted-local:orchestration:retained-batch',
        turn: {
          body: {
            ...hostTestMessage('accepted legacy batch'),
            from: {
              ...from,
              orchestration: {
                ...from.orchestration,
                messages: retained.map((source) => ({
                  runId: source.run_id,
                  messageId: source.id,
                  from: source.from_handle
                }))
              }
            }
          },
          operationId: hostTestOperationId(),
          expectedRuntimeFence: host.deps.store.getRecord(COORDINATOR)!.lease.runtimeFence,
          delivery: 'queue',
          queueAlways: true
        }
      })
    ).toMatchObject({ kind: 'queued' })
    // Cold locator work is measured in the file-backed original-history scenario, separately.
    expect(readMailCreationHistory(host, COORDINATOR).members.size).toBe(count)
    const contributions = observeMailHistoryWork(originalMailHistory(host))
    contributions.reset()
    const database = host.deps.journalDatabase.db
    const census = vi.spyOn(database, 'prepare')
    const originals = observeMailSqlWork(
      database,
      (sql) =>
        sql.replace(/\s+/g, ' ').trim() ===
        'SELECT row_json FROM journal_rows WHERE session_id = ? AND epoch = ? AND seq = ?',
      'row_json'
    )
    try {
      for (let k = 0; k < 3; k++) {
        const task = db.createTask({ runId, spec: `actual task ${k}` })
        const dispatch = createRootDispatch(
          db,
          task.id,
          formatOrcaSessionAddress(testOrcaSessionId(PEER_CHAT))
        )
        expect(
          await sendChatTask({
            db,
            dispatch,
            from: dispatchTaskSource({
              db,
              dispatch,
              from: `run:${runId}`,
              senderName: () => null
            }),
            preamble: `new task preamble ${k}`
          })
        ).toBe('queued')
        await observationClock.observe(30)
      }
      expect(
        census.mock.calls.filter(([sql]) =>
          sql.startsWith('SELECT session_id, epoch, seq, row_json FROM journal_rows')
        )
      ).toHaveLength(0)
      expect(originals.count()).toBeLessThanOrEqual(12)
      const upstream = contributions.snapshot()
      expect(upstream.selections).toBeLessThanOrEqual(12)
      expect(upstream.visits).toBeLessThanOrEqual(120)
      expect(upstream.reads + upstream.writes).toBeLessThanOrEqual(240)
      const queued = journal.queuedMessages.list().filter((card) => card.state === 'waiting')
      expect(queued).toHaveLength(3)
      expect(worker.turns).toHaveLength(1)
      const hot = {
        count,
        tasks: 3,
        upstream,
        originalRows: originals.count(),
        originalBytes: originals.evaluatedBytes()
      }
      console.info('actual-chat-task-history-work', JSON.stringify(hot))
      originals.verify()
      // These are real ordinary cards, not mail-specific work held in a parallel list.
      await settleTurn(PEER_CHAT, 0, 'completed')
      for (let k = 1; k <= 3; k++) {
        await vi.waitFor(() => expect(worker.turns).toHaveLength(k + 1), WAIT)
        await observationClock.observe(30)
        expect(worker.turns).toHaveLength(k + 1)
        await settleTurn(PEER_CHAT, k, 'completed')
      }
      for (const card of queued) {
        expect(journal.queuedMessages.get(card.messageId)).toMatchObject({ state: 'dispatched' })
        const submission = (await host.journalSnapshot(PEER_CHAT)).submissions.find(
          (row) => row.queuedMessageId === card.messageId
        )
        expect(submission).toBeDefined()
        expect(submission?.clientMessageId).not.toBe(card.messageId)
      }
      // Vary original domains independently of the three producer commits and ten cards per domain.
      const domains = Array.from({ length: count / 10 }, (_, n) => `history-domain-${n}`)
      for (const sessionId of domains) {
        const params = attachParams(sessionId)
        params.envelope.payloadFingerprint = computeAgentSessionPayloadFingerprint({
          method: 'agentSession.create',
          sessionId,
          fields: { worktree: `id:${params.location.workspaceId}`, agent: params.agent }
        })
        expect(await host.create({ callerKey: 'test-surface' }, params)).toMatchObject({ ok: true })
        expect(
          await host.cancel(
            { callerKey: 'test-surface' },
            {
              envelope: {
                sessionId,
                clientOperationId: hostTestOperationId(),
                expectedRuntimeFence: host.deps.store.getRecord(sessionId)!.lease.runtimeFence,
                payloadFingerprint: computeAgentSessionPayloadFingerprint({
                  method: 'agentSession.cancel',
                  sessionId,
                  fields: {}
                })
              }
            }
          )
        ).toMatchObject({ ok: true })
      }
      const canonical: { sessionId: string; messageId: string }[] = []
      for (let n = 0; n < count; n++) {
        const sessionId = domains[n % domains.length]!
        const source = db.insertMessage({
          runId,
          from: 'worker',
          to: 'retained-legacy',
          subject: `canonical-${n}`
        })
        db.markAsRead([source.id])
        const messageId = ordinaryMailCreationId(source)
        const result = await sendAgentTurn({
          kind: 'structured-session',
          host,
          sessionId,
          callerKey: MAIL_CALLER,
          turn: {
            operationId: messageId,
            expectedRuntimeFence: host.deps.store.getRecord(sessionId)!.lease.runtimeFence,
            delivery: 'queue',
            queueAlways: true,
            body: {
              ...hostTestMessage(source.subject),
              from: structuredMailSource({
                db,
                mailboxHandle: 'retained-legacy',
                dispatchId: null,
                message: source,
                senderName: () => null
              })
            }
          }
        })
        expect(result).toMatchObject({ kind: 'queued' })
        canonical.push({ sessionId, messageId })
      }
      readMailCreationHistory(host, COORDINATOR)
      contributions.reset()
      for (const card of canonical) {
        expect(
          await host.queuedMessageDelete(
            { callerKey: 'test-surface' },
            {
              messageId: card.messageId,
              envelope: {
                sessionId: card.sessionId,
                clientOperationId: hostTestOperationId(),
                expectedRuntimeFence: host.deps.store.getRecord(card.sessionId)!.lease.runtimeFence,
                payloadFingerprint: computeAgentSessionPayloadFingerprint({
                  method: 'agentSession.queuedMessageDelete',
                  sessionId: card.sessionId,
                  fields: { messageId: card.messageId }
                })
              }
            }
          )
        ).toMatchObject({ ok: true })
        readMailCreationHistory(host, card.sessionId)
      }
      const retirement = contributions.snapshot()
      expect(retirement.visits).toBeLessThanOrEqual(count * 30)
      expect(retirement.selections).toBeLessThanOrEqual(count * 3)
      expect(
        canonical.every(
          (card) =>
            host
              .collaboratorsForTests()
              .sessions.get(card.sessionId)!
              .journal.queuedMessages.get(card.messageId)?.state === 'withdrawn'
        )
      ).toBe(true)
      console.info(
        'canonical-retirement-work',
        JSON.stringify({ count, domains: domains.length, retirement })
      )
    } finally {
      contributions.restore()
      originals.restore()
      census.mockRestore()
    }
  },
  90_000
)
