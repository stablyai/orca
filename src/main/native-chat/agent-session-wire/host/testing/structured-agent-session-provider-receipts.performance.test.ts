import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import {
  waitForReplay,
  forgetWaiter
} from '../../../../claude/structured/dispatch/claude-structured-dispatch-waiters'
import { JournalSqlOwner } from '../../../agent-session-journal/journal-sql-owner'
import { SqlAgentSessionJournal } from '../../../agent-session-journal/journal-sql-store'
import { journalDomainDatabasePath } from '../../../agent-session-journal/database/journal-host-database'
import { journalSqlWorkerPath } from '../../../agent-session-journal/journal-sql-worker-bundle.test-fixture'
import { createQueuedMessageTestRig } from './structured-agent-session-queued-message-rig.test-fixture'
import {
  claudeReceiptIngress,
  openReceiptStream
} from './structured-agent-session-provider-receipt-rig.test-fixture'
import { structuredAgentSessionHandingOver } from '../../delivery/structured-agent-session-handing-over'
import { eventually } from './structured-agent-session-queued-message-rig-provider.test-fixture'
import {
  HOST_TEST_SESSION as CHAT,
  HOST_TEST_NOW as NOW
} from './structured-agent-session-host-test-data.test-fixture'

const eventLoop = () => new Promise<void>((resolve) => setImmediate(resolve))

async function gatedBulkWriter(root: string): Promise<string> {
  const entry = join(root, 'receipt-bulk-writer.cjs')
  await writeFile(
    entry,
    `
    const { DatabaseSync } = require('node:sqlite')
    const { existsSync, writeFileSync } = require('node:fs')
    const prepare = DatabaseSync.prototype.prepare
    const exec = DatabaseSync.prototype.exec
    const armed = new WeakSet()
    const started = ${JSON.stringify(join(root, 'bulk-started'))}
    const resume = ${JSON.stringify(join(root, 'bulk-resume'))}
    const clock = new Int32Array(new SharedArrayBuffer(4))
    DatabaseSync.prototype.prepare = function(sql) {
      const statement = prepare.call(this, sql)
      if (sql.startsWith('INSERT INTO journal_items(')) {
        const run = statement.run
        statement.run = (...bindings) => {
          const result = run.apply(statement, bindings)
          if (bindings[2] === 'orca:other-0') armed.add(this)
          return result
        }
      }
      return statement
    }
    DatabaseSync.prototype.exec = function(sql) {
      if (sql === 'COMMIT' && armed.delete(this)) {
        writeFileSync(started, '')
        const deadline = Date.now() + 8000
        while (!existsSync(resume)) {
          if (Date.now() >= deadline) throw new Error('bulk commit barrier timed out')
          Atomics.wait(clock, 0, 0, 5)
        }
      }
      return exec.call(this, sql)
    }
    require(${JSON.stringify(journalSqlWorkerPath())})
  `
  )
  return entry
}

it.each([100, 1_000])(
  'uses only keyed memory delivery at %s provider frames per second, with and without receipt readers',
  async (count) => {
    const rig = await createQueuedMessageTestRig({ agent: 'claude', writerBundle: gatedBulkWriter })
    try {
      const id = await rig.workingSend()
      await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(1))
      const ingress = claudeReceiptIngress(rig)
      const { sessions, runtimeState, deps } = rig.host.collaboratorsForTests()
      const session = sessions.get(CHAT)!
      const { journal, child, providerReceipts } = session
      await eventually(() => expect(structuredAgentSessionHandingOver(journal).size).toBe(0))
      const bulk = await SqlAgentSessionJournal.open({
        database: deps.journalDatabase,
        identity: { ...journal.identity, sessionId: 'receipt-perf-bulk' }
      })
      const append = (owner: SqlAgentSessionJournal, name: string) =>
        owner.appendItem(
          { provider: 'orca', clientMessageId: name },
          { kind: 'status', text: name },
          { fence: ingress.fence, turnScope: { kind: 'thread' } }
        )
      try {
        let sequence = ingress.handover.handoverCursor.sequence
        const burst = async (phase: string, afterIngress?: () => Promise<void>) => {
          const refresh = vi.spyOn(runtimeState, 'refreshActivity')
          const point = vi.spyOn(deps.journalDatabase.readers, 'point')
          const write = vi.spyOn(JournalSqlOwner.prototype, 'write')
          const publications = vi.fn()
          const stop = sessions.observeConversationPublications(CHAT, {
            next: publications,
            error: (error) => {
              throw error
            }
          })
          publications.mockClear()
          const cursor = journal.cursor()
          const begin = performance.now()
          try {
            for (let offset = 0; offset < count; offset += 32) {
              const chunk = Array.from({ length: Math.min(32, count - offset) }, (_, index) => {
                const id = `receipt-${offset + index}`
                const handover = {
                  ...ingress.handover,
                  handoverCursor: { ...ingress.handover.handoverCursor, sequence: ++sequence }
                }
                providerReceipts!.register(CHAT, journal, child!, id, handover)
                const { waiter } = waitForReplay(
                  ingress.session,
                  false,
                  id,
                  '',
                  id,
                  NOW,
                  ingress.fence,
                  handover
                )
                return waiter
              })
              for (const waiter of chunk) {
                ingress.lifecycle('queued', NOW, waiter.sentUuid)
              }
              await eventLoop()
              for (const waiter of chunk) {
                forgetWaiter(ingress.session, waiter)
                ingress.sink.withdrawProviderReceipt?.({
                  ...waiter.handover!,
                  fence: ingress.fence,
                  clientMessageId: waiter.clientMessageId!
                })
              }
              await eventLoop()
            }
            expect(performance.now() - begin).toBeLessThan(1_000)
            await afterIngress?.()
            expect(await ingress.flush()).toEqual({ ok: true })
            expect(journal.cursor()).toEqual(cursor)
            expect(refresh).not.toHaveBeenCalled()
            expect(point.mock.calls.filter(([scope]) => scope.sessionId === CHAT)).toEqual([])
            expect(
              write.mock.calls.filter(([command]) => command.target.sessionId === CHAT)
            ).toEqual([])
            expect(publications).not.toHaveBeenCalled()
          } finally {
            stop()
            refresh.mockRestore()
            point.mockRestore()
            write.mockRestore()
          }
          console.log({
            phase,
            receipts: count,
            milliseconds: Math.round(performance.now() - begin),
            activityRefresh: 0,
            readerRequests: 0,
            writerAdmissions: 0,
            structuralPublications: 0
          })
        }
        await session.activityRead
        const wal = `${journalDomainDatabasePath(rig.root)}-wal`
        const before = (await stat(wal)).size
        await burst('no subscribers')
        expect((await stat(wal)).size - before).toBe(0)

        const legacy = vi.fn()
        const stopLegacy = await rig.host.subscribe({ id: 'legacy', sessionId: CHAT, emit: legacy })
        await eventually(() => expect(legacy).toHaveBeenCalled())
        await eventLoop()
        legacy.mockClear()
        await burst('legacy')
        expect(legacy).not.toHaveBeenCalled()

        const fast = await openReceiptStream(rig)
        const held = await openReceiptStream(rig, { paused: true })
        let firstBulkCommitted = false
        const bulkWrites = Promise.all(
          Array.from({ length: 50 }, (_, index) => append(bulk, `other-${index}`)).map(
            (write, index) =>
              write.then((item) => {
                if (index === 0) {
                  firstBulkCommitted = true
                }
                return item
              })
          )
        )
        const release = () => writeFile(join(rig.root, 'bulk-resume'), '')
        try {
          await eventually(async () => {
            expect((await stat(join(rig.root, 'bulk-started'))).isFile()).toBe(true)
          })
          await burst('fast and stalled with bulk work', async () => {
            expect(firstBulkCommitted).toBe(false)
            await release()
          })
        } finally {
          await release()
          await bulkWrites
        }
        const stamps = fast.frames
          .flatMap((frame) => frame.updates)
          .filter((update) => typeof update.observedAt === 'number')
        expect(stamps).toHaveLength(count)
        expect(fast.frames.slice(1).every((frame) => !frame.replace)).toBe(true)
        expect(held.frames).toHaveLength(1)
        expect(legacy).not.toHaveBeenCalled()
        await append(journal, 'ordinary-content')
        await eventually(() =>
          expect(JSON.stringify(legacy.mock.calls)).toContain('ordinary-content')
        )

        const seen = fast.frames.length
        ingress.lifecycle('started', NOW + 100)
        await eventually(() => expect(fast.frames).toHaveLength(seen + 1))
        expect(fast.frames.at(-1)?.updates).toEqual([
          { clientMessageId: id, observedAt: NOW + 100 }
        ])
        held.close()
        fast.close()
        stopLegacy()
        expect(held.frames).toHaveLength(1)
      } finally {
        await bulk.close()
      }
    } finally {
      await rig.dispose()
    }
  },
  30_000
)
