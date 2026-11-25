import type { StructuredAgentSessionEventSink } from '../agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withTestAgentSessionDatabase } from '../../runtime/agent-session/records/agent-session-record-store-persistence.test-fixture'
import { createQueuedMessageTestRig } from '../agent-session-wire/host/testing/structured-agent-session-queued-message-rig.test-fixture'
import { openJournalDomainDatabase } from './database/journal-domain-database'
import { applyJournalDomainDispatchWritten } from './journal-domain-dispatch-written'
import { expect, it, vi } from 'vitest'
import { StructuredAgentSessionConversations } from '../agent-session-wire/host/structured-agent-session-conversations'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION,
  hostTestAttachParams,
  hostTestMessage
} from '../agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import { openJournal, receipt } from './journal-dispatch-written.test-fixture'

it('keeps a receipt commit off the host publication and reader paths', async () => {
  const journal = await openJournal()
  const body = {
    kind: 'message' as const,
    role: 'user' as const,
    blocks: [{ type: 'text' as const, text: 'Check the job' }]
  }
  await journal.appendSubmission({
    clientMessageId: 'send',
    payloadFingerprint: 'send',
    body,
    fence: 2,
    handoverRecorded: true,
    origin: 'client'
  })
  const { handoverCursor } = await journal.prepareHandover({
    clientMessageId: 'send',
    body,
    fence: 2,
    turnScope: { kind: 'thread' }
  })
  let now = 100
  const observe = vi.fn()
  const deliver = vi.fn()
  const workChanged = vi.fn()
  const generationObserver = vi.fn()
  const sessions = new StructuredAgentSessionConversations({
    observe,
    deliver,
    workChanged,
    logger: { warn: () => {}, error: () => {} },
    now: () => now
  })
  sessions.set('session', { journal, params: hostTestAttachParams(null), child: null })
  const release = sessions.observeConversationPublications('session', {
    next: generationObserver,
    error: (error) => {
      throw error
    }
  })
  observe.mockClear()
  workChanged.mockClear()
  generationObserver.mockClear()
  const cursor = journal.cursor()
  try {
    now = 500
    await journal.markDispatchWritten({
      clientMessageId: 'send',
      handoverCursor: handoverCursor!,
      fence: 2,
      observedAt: now,
      providerReceipt: true
    })
    expect(await receipt('send')).toBe(500)
    expect(sessions.lastActivityAt('session')).toBe(500)
    expect(journal.cursor()).toEqual(cursor)
    expect(observe).not.toHaveBeenCalled()
    expect(deliver).not.toHaveBeenCalled()
    expect(workChanged).not.toHaveBeenCalled()
    expect(generationObserver).not.toHaveBeenCalled()
  } finally {
    release()
    sessions.clear()
  }
})

it.each([100, 1_000])(
  'ingests %s receipts without refreshing activity or asking readers',
  async (count) => {
    const rig = await createQueuedMessageTestRig({ agent: 'claude' })
    try {
      await rig.workingSend()
      const { runtimeState, sessions, deps, serialize } = rig.host.collaboratorsForTests()
      const session = sessions.get(HOST_TEST_SESSION)!
      const { journal, child } = session
      const fence = child!.fence
      const receipts: Parameters<
        NonNullable<StructuredAgentSessionEventSink['recordProviderReceipt']>
      >[0][] = []
      for (let index = 0; index < count; index++) {
        const clientMessageId = `receipt-${index}`
        await journal.appendSubmission({
          clientMessageId,
          payloadFingerprint: clientMessageId,
          body: hostTestMessage(clientMessageId),
          fence,
          handoverRecorded: true,
          origin: 'client'
        })
        const { handoverCursor } = await journal.prepareHandover({
          clientMessageId,
          body: hostTestMessage(clientMessageId),
          fence,
          turnScope: { kind: 'thread' }
        })
        receipts.push({
          clientMessageId,
          handoverCursor: handoverCursor!,
          fence,
          observedAt: HOST_TEST_NOW + index
        })
      }
      await serialize(HOST_TEST_SESSION, async () => {})
      await session.activityRead
      const sink = rig.providerEvents()
      const refresh = vi.spyOn(runtimeState, 'refreshActivity')
      const requests = vi.spyOn(deps.journalDatabase.readers, 'point')
      const frames = vi.fn()
      const stop = sessions.observeConversationPublications(HOST_TEST_SESSION, {
        next: frames,
        error: (error) => {
          throw error
        }
      })
      frames.mockClear()
      try {
        const before = journal.cursor()
        for (const receipt of receipts) {
          sink.recordProviderReceipt?.(receipt)
        }
        expect(await sink.written!()).toEqual({ ok: true })
        await session.activityRead
        expect(refresh).toHaveBeenCalledTimes(0)
        expect(requests).toHaveBeenCalledTimes(0)
        expect(frames).toHaveBeenCalledTimes(0)
        expect(journal.cursor()).toEqual(before)
        const stamped = await withTestAgentSessionDatabase(
          rig.root,
          (db) =>
            db
              .prepare('SELECT count(*) AS count FROM journal_dispatch_written WHERE session_id=?')
              .get(HOST_TEST_SESSION)?.count
        )
        expect(stamped).toBe(count)
      } finally {
        stop()
        refresh.mockRestore()
        requests.mockRestore()
      }
    } finally {
      await rig.dispose()
    }
  },
  30_000
)

it('receipt guards read no carrier pages and stamp the same WAL bytes at both carries widths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-receipt-bytes-'))
  const sizes: number[] = []
  try {
    for (const count of [1_000, 10_000]) {
      const path = join(root, `carrier-${count}.db`)
      const { db } = openJournalDomainDatabase(path)
      try {
        db.prepare(`INSERT INTO journal_chat_state(session_id,workspace_id,epoch,last_sequence,highest_fence)
          VALUES('session','workspace','epoch',5,2)`).run()
        db.prepare(`INSERT INTO journal_submission_attempts(
          session_id,epoch,message_id,attempt_sequence,attempt_index,current,item_id,ordinal,
          submitted_at,fingerprint,dispatch_state,facts_json,payload_json)
          VALUES('session','epoch','send',1,0,1,'orca:send',1,100,'send','pending',?,'{}')`).run(
          JSON.stringify({
            handover: { sequence: 5, fence: 2, scope: { kind: 'thread' } },
            carries: Array.from(
              { length: count },
              (_, index) => `orca:${String(index).padStart(36, '0')}`
            )
          })
        )
        db.pragma('wal_checkpoint(TRUNCATE)')
        const table = db
          .prepare("SELECT rootpage FROM sqlite_schema WHERE name='journal_submission_attempts'")
          .get()
        const statements = vi.spyOn(db, 'prepare')
        try {
          db.exec('BEGIN IMMEDIATE')
          const stamped = applyJournalDomainDispatchWritten(
            db,
            { sessionId: 'session', epoch: 'epoch' },
            {
              kind: 'dispatch-written',
              clientMessageId: 'send',
              fence: 2,
              handoverCursor: { epoch: 'epoch', sequence: 5 },
              observedAt: 500
            }
          )
          db.exec('COMMIT')
          expect(stamped.writtenOnly).toBe(true)
          sizes.push((await stat(`${path}-wal`)).size)
          const writes = statements.mock.calls.map(([sql]) => sql)
          for (const sql of writes) {
            const bindings = Array<null>(sql.split('?').length - 1).fill(null)
            const plan = db.prepare(`EXPLAIN ${sql}`).all(...bindings)
            const carrier = plan.find(
              (step) => step.opcode === 'OpenRead' && step.p2 === table?.rootpage
            )
            if (carrier) {
              // SQLite can open a deferred table cursor for the index without reading it.
              expect(
                plan.filter(
                  (step) =>
                    step.p1 === carrier.p1 && ['Column', 'SeekRowid'].includes(String(step.opcode))
                )
              ).toEqual([])
            }
          }
        } finally {
          statements.mockRestore()
        }
      } finally {
        db.close()
      }
    }
    expect(sizes[0]).toBeGreaterThan(0)
    expect(sizes[1]).toBe(sizes[0])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
