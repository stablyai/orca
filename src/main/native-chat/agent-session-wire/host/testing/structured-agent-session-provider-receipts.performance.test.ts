import type { AgentSessionProviderReceiptFrame } from '../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-provider-receipts'
import {
  MAX_HOST_PROVIDER_RECEIPTS,
  MAX_HOST_PROVIDER_RECEIPT_BYTES,
  StructuredAgentSessionProviderReceipts
} from '../structured-agent-session-provider-receipts'
import {
  MAX_PROVIDER_RECEIPT_FRAME_BYTES,
  MAX_PROVIDER_RECEIPT_FRAME_ENTRIES,
  MAX_PROVIDER_RECEIPT_KEY_LENGTH,
  MAX_PROVIDER_RECEIPT_STREAMS
} from '../../publication/subscribers/agent-session-subscriber-receipts'
import { stat } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import {
  waitForReplay,
  forgetWaiter
} from '../../../../claude/structured/dispatch/claude-structured-dispatch-waiters'
import { JournalSqlOwner } from '../../../agent-session-journal/journal-sql-owner'
import { SqlAgentSessionJournal } from '../../../agent-session-journal/journal-sql-store'
import { journalDomainDatabasePath } from '../../../agent-session-journal/database/journal-host-database'
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

it.each([100, 1_000])(
  'uses only keyed memory delivery at %s provider frames per second, with and without receipt readers',
  async (count) => {
    const rig = await createQueuedMessageTestRig({ agent: 'claude' })
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
        const burst = async (phase: string) => {
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
        const unblock = Promise.withResolvers<void>()
        const held: unknown[] = []
        const stopStalled = await rig.host.subscribe({
          id: 'stalled',
          sessionId: CHAT,
          emit: () => {},
          emitProviderReceipts: (frame) => {
            held.push(frame)
            return unblock.promise
          }
        })
        await eventually(() => expect(held).toHaveLength(1))
        await eventLoop()
        const bulkWrites = Promise.all(
          Array.from({ length: 50 }, (_, index) => append(bulk, `other-${index}`))
        )
        await burst('fast and stalled with bulk work')
        await bulkWrites
        const stamps = fast.frames
          .flatMap((frame) => frame.updates)
          .filter((update) => typeof update.observedAt === 'number')
        expect(stamps).toHaveLength(count)
        expect(fast.frames.slice(1).every((frame) => !frame.replace)).toBe(true)
        expect(held).toHaveLength(1)
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
        stopStalled()
        unblock.resolve()
        fast.close()
        stopLegacy()
        expect(held).toHaveLength(1)
      } finally {
        await bulk.close()
      }
    } finally {
      await rig.dispose()
    }
  },
  30_000
)

it('bounds handovers and delivery by chat, host and stream, including worst-case escaped keys', async () => {
  const rig = await createQueuedMessageTestRig()
  try {
    await rig.workingSend()
    const { sessions } = rig.host.collaboratorsForTests()
    const session = sessions.get(CHAT)!
    const { journal, child } = session
    let owner = child!
    const index = new StructuredAgentSessionProviderReceipts(
      () => ({ ...session, child: owner }),
      () => owner.fence
    )
    const streams: (() => void)[] = []
    try {
      for (let stream = 0; stream < MAX_PROVIDER_RECEIPT_STREAMS; stream++) {
        streams.push(index.subscribe('unrelated', () => {})!.close)
      }
      expect(index.subscribe(CHAT, () => {})).toBeUndefined()
      streams.pop()!()
      const frames: AgentSessionProviderReceiptFrame[] = []
      const subscriber = index.subscribe(CHAT, (frame) => void frames.push(frame))!
      subscriber.open()
      await eventLoop()

      const make = (number: number) => ({
        clientMessageId: String(number).padStart(MAX_PROVIDER_RECEIPT_KEY_LENGTH, '\u0000'),
        fence: child!.fence,
        handoverCursor: { epoch: journal.physicalCursor().epoch, sequence: number },
        attempt: number,
        observedAt: NOW
      })
      const add = (chat: string, number: number) => {
        const observation = make(number)
        index.register(chat, journal, owner, observation.clientMessageId, observation)
        index.stamp(chat, owner, observation)
      }
      for (const capacity of [16, 160, MAX_PROVIDER_RECEIPT_FRAME_ENTRIES]) {
        frames.length = 0
        for (let number = 0; number < capacity; number++) {
          add(CHAT, number)
          index.stamp(CHAT, owner, make(number))
        }
        await eventLoop()
        expect(frames).toHaveLength(1)
        expect(frames[0]).toMatchObject({ replace: false, revision: expect.any(Number) })
        expect(frames[0]!.updates).toHaveLength(capacity)
        expect(Buffer.byteLength(JSON.stringify(frames[0]), 'utf8')).toBeLessThanOrEqual(
          MAX_PROVIDER_RECEIPT_FRAME_BYTES
        )
        index.retire(CHAT)
        await eventLoop()
        expect(frames[1]).toMatchObject({ replace: true, updates: [] })
      }

      for (let indexNo = 0; indexNo < MAX_HOST_PROVIDER_RECEIPTS; indexNo++) {
        const chat = `other-${Math.floor(indexNo / MAX_PROVIDER_RECEIPT_FRAME_ENTRIES)}`
        add(chat, indexNo)
      }
      const revision = frames.at(-1)!.revision
      add(CHAT, 0)
      await eventLoop()
      expect(frames.at(-1)!.revision).toBe(revision)
      index.retire('other-0')
      for (let number = 0; number <= MAX_PROVIDER_RECEIPT_FRAME_ENTRIES; number++) {
        add(CHAT, number)
      }
      await eventLoop()
      expect(frames.at(-1)!.updates).toHaveLength(MAX_PROVIDER_RECEIPT_FRAME_ENTRIES)
      const preceding = frames.at(-1)!.revision
      owner = { ...owner }
      index.revalidate(CHAT)
      index.stamp(CHAT, child!, make(0))
      await eventLoop()
      expect(frames.at(-1)).toMatchObject({ replace: true, revision: preceding + 1, updates: [] })
      subscriber.close()
      expect(MAX_HOST_PROVIDER_RECEIPT_BYTES).toBe(116 * 1024 * 1024)
    } finally {
      for (const close of streams) {
        close()
      }
      index.close()
    }
    expect(index.subscribe(CHAT, () => {})).toBeUndefined()
  } finally {
    await rig.dispose()
  }
})
