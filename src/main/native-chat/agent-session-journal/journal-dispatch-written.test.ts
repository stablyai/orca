import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { openStructuredAgentSessionSqlJournalDatabase } from '../../runtime/agent-session/installation/structured-agent-session-journal-open'
import { createDeferredStructuredAgentSessionEventSink } from '../agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { createStructuredAgentSessionLogger } from '../agent-session-wire/host/structured-agent-session-logger'
import type { JournalSqlDatabase } from './database/journal-sql-database'
import { SqlAgentSessionJournal } from './journal-sql-store'
import { closeTestJournalHostDatabases } from './store-lifecycle/journal-host-database-test-support'
import {
  journalSqlReaderPath,
  journalSqlWorkerPath
} from './journal-sql-worker-bundle.test-fixture'

const roots: string[] = []
const databases: JournalSqlDatabase[] = []
const journals: { close(): Promise<void> }[] = []
afterEach(async () => {
  await Promise.all(journals.splice(0).map((journal) => journal.close()))
  await Promise.all(databases.splice(0).map((database) => database.close()))
  await closeTestJournalHostDatabases()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const body = {
  kind: 'message' as const,
  role: 'user' as const,
  blocks: [{ type: 'text' as const, text: 'look at this' }]
}

async function openJournal(now = 100): Promise<SqlAgentSessionJournal> {
  const root = await mkdtemp(join(tmpdir(), 'journal-dispatch-written-'))
  roots.push(root)
  const { journalDatabase } = await openStructuredAgentSessionSqlJournalDatabase({
    stateDirectory: root,
    writerPath: journalSqlWorkerPath(),
    readerPath: journalSqlReaderPath(),
    logger: { warn: () => {}, error: () => {} }
  })
  databases.push(journalDatabase)
  const journal = await SqlAgentSessionJournal.open({
    database: journalDatabase,
    identity: {
      sessionId: 'session',
      workspaceId: 'workspace',
      hostId: 'host',
      agent: 'codex',
      providerHandle: codexProviderHandle('thread')
    },
    now: () => now
  })
  journals.push(journal)
  return journal
}

describe('a send the agent took', () => {
  it('stamps provider receipts once for the current handover, including steers', async () => {
    const journal = await openJournal()
    for (const clientMessageId of ['idle', 'steer', 'echoed']) {
      await journal.appendSubmission({
        clientMessageId,
        payloadFingerprint: `fingerprint:${clientMessageId}`,
        body,
        fence: 2,
        handoverRecorded: true,
        origin: 'client'
      })
    }
    const { handoverCursor: idle } = await journal.prepareHandover({
      clientMessageId: 'idle',
      fence: 2,
      turnScope: { kind: 'thread' },
      body
    })
    const { handoverCursor: steer } = await journal.prepareHandover({
      clientMessageId: 'steer',
      fence: 2,
      turnScope: { kind: 'turn', turnItemId: 'orca:turn-running' },
      body
    })
    const { handoverCursor: echoed } = await journal.prepareHandover({
      clientMessageId: 'echoed',
      fence: 2,
      turnScope: { kind: 'thread' },
      body
    })
    await journal.resolveDispatch({
      clientMessageId: 'echoed',
      fence: 2,
      state: 'accepted',
      providerIdentity: null
    })

    const before = journal.cursor()
    await journal.markDispatchWritten({
      clientMessageId: 'steer',
      handoverCursor: steer!,
      fence: 1,
      observedAt: 70,
      providerReceipt: true
    })
    await journal.markDispatchWritten({
      clientMessageId: 'steer',
      handoverCursor: steer!,
      fence: 2,
      observedAt: 71
    })
    await journal.markDispatchWritten({
      clientMessageId: 'echoed',
      handoverCursor: echoed!,
      fence: 2,
      observedAt: 72,
      providerReceipt: true
    })
    expect(journal.cursor()).toEqual(before)
    await journal.markDispatchWritten({
      clientMessageId: 'idle',
      handoverCursor: idle!,
      fence: 2,
      observedAt: 80
    })
    await journal.markDispatchWritten({
      clientMessageId: 'steer',
      handoverCursor: steer!,
      fence: 2,
      observedAt: 81,
      providerReceipt: true
    })
    expect(journal.cursor().sequence).toBe(before.sequence + 2)
    await journal.markDispatchWritten({
      clientMessageId: 'steer',
      handoverCursor: steer!,
      fence: 2,
      observedAt: 90,
      providerReceipt: true
    })
    expect(journal.cursor().sequence).toBe(before.sequence + 2)

    expect(await journal.reads.submission('idle')).toMatchObject({
      dispatchState: 'pending',
      writtenAt: 80
    })
    expect((await journal.reads.submission('steer'))?.writtenAt).toBe(81)
    expect((await journal.reads.submission('echoed'))?.writtenAt).toBeUndefined()
  })

  it('rejects a delayed provider callback after re-handover at the same fence and time', async () => {
    const journal = await openJournal()
    const input = {
      clientMessageId: 'retry',
      fence: 2,
      turnScope: { kind: 'thread' as const },
      body
    }
    await journal.appendSubmission({
      ...input,
      payloadFingerprint: 'retry',
      handoverRecorded: true,
      origin: 'client'
    })
    const first = await journal.prepareHandover(input)
    const next = await journal.prepareHandover(input)
    const at = journal.cursor()
    const delivery = createDeferredStructuredAgentSessionEventSink({
      sessionId: 'session',
      logger: createStructuredAgentSessionLogger()
    })
    delivery.bind({ journal, fence: 2, publish: () => {} })
    const receive = (handoverCursor: typeof first.handoverCursor, observedAt: number) =>
      delivery.sink.recordProviderReceipt?.({
        clientMessageId: 'retry',
        fence: 2,
        handoverCursor: handoverCursor!,
        observedAt
      })
    try {
      receive(first.handoverCursor, 201)
      expect(await delivery.drained()).toEqual({ ok: true })
      expect(journal.cursor()).toEqual(at)
      expect((await journal.reads.submission('retry'))?.writtenAt).toBeUndefined()

      receive(next.handoverCursor, 202)
      expect(await delivery.drained()).toEqual({ ok: true })
      expect((await journal.reads.submission('retry'))?.writtenAt).toBe(202)
    } finally {
      delivery.close()
    }
  })

  // Readers without queued-image support take the image-admission route; the stamp must reach them too.
  it('pages a provider receipt before the turn start for a reader with a queued-image policy', async () => {
    const journal = await openJournal(200)
    await journal.appendSubmission({
      clientMessageId: 'idle',
      payloadFingerprint: 'fingerprint:idle',
      body,
      fence: 2,
      handoverRecorded: true,
      origin: 'client'
    })
    const { handoverCursor } = await journal.prepareHandover({
      clientMessageId: 'idle',
      fence: 2,
      turnScope: { kind: 'thread' },
      body
    })
    const reader = {
      form: 'client' as const,
      budgetBytes: 1_000_000,
      queuedImages: { ids: [['other', true] as const], imageIds: [] }
    }
    const before = (await journal.history({ direction: 'tail', reader })).result
    if (!before.ok || !before.page.liveCursor) {
      throw new Error('tail read reset')
    }
    const delivery = createDeferredStructuredAgentSessionEventSink({
      sessionId: 'session',
      logger: createStructuredAgentSessionLogger()
    })
    delivery.bind({ journal, fence: 2, publish: () => {} })
    delivery.sink.recordProviderReceipt?.({
      clientMessageId: 'idle',
      fence: 2,
      handoverCursor: handoverCursor!,
      observedAt: 150
    })
    delivery.sink.appendItem(
      { provider: 'orca', clientMessageId: 'turn' },
      { kind: 'turn', turnId: 'turn', state: 'running', userItemId: 'orca:idle', startedAt: 150 },
      { turnScope: { kind: 'thread' } }
    )
    expect(await delivery.drained()).toEqual({ ok: true })
    delivery.close()
    const after = (
      await journal.history({
        direction: 'after',
        cursor: before.page.liveCursor,
        reader,
        limit: 1
      })
    ).result
    if (!after.ok) {
      throw new Error('receipt catch-up reset')
    }
    expect(after.page.items).toEqual([])
    expect(after.page.submissions.map((send) => send.writtenAt)).toEqual([150])
    expect(after.page.window.nextCursor.sequence).toBe(before.page.liveCursor.sequence + 1)
    const next = (
      await journal.history({
        direction: 'after',
        cursor: after.page.window.nextCursor,
        reader,
        limit: 1
      })
    ).result
    expect(next.ok && next.page.items.map((item) => item.body)).toEqual([
      {
        kind: 'turn',
        turnId: 'turn',
        state: 'running',
        userItemId: 'orca:idle',
        startedAt: 150
      }
    ])
    expect(next.ok && next.page.window.nextCursor.sequence).toBe(
      before.page.liveCursor.sequence + 2
    )
  })
})
