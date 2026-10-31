import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { expect, it, vi } from 'vitest'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import { StructuredNativeResponses } from './structured-agent-session-native-responses'
import { structuredAgentSessionReceivingAccount } from './structured-agent-session-receiving-account'
import {
  createReceivingAccountFixture,
  RECEIVING_A,
  SELECTED_B
} from './structured-agent-session-receiving-account.test-support'

it('retains queued pointer ownership across epoch replacement, then disposes only its actual response', async () => {
  const f = await createReceivingAccountFixture()
  try {
    const message = f.finish(f.start())
    const body = f.body(message)
    const target = () => structuredAgentSessionReceivingAccount(f.deps, f.record, f.session)
    await f.journal.queuedMessages.insert({ messageId: 'native-pointer-card', body })
    f.db.markAsDelivered([message.id], `run:${f.run.id}`)
    expect((await target()).home).toEqual(RECEIVING_A)
    await f.journal.replaceEpochItems('handle_forked', 2, [])
    expect((await target()).home).toEqual(RECEIVING_A)
    await f.journal.appendSubmission(
      {
        clientMessageId: 'queued-native-response',
        payloadFingerprint: agentSessionSendBodyFingerprint(f.root, body),
        body,
        origin: 'host',
        fence: 2,
        handoverRecorded: true
      },
      { messageId: 'native-pointer-card', expect: 'waiting' }
    )
    await f.journal.resolveDispatch({
      clientMessageId: 'queued-native-response',
      fence: 2,
      state: 'pending',
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    await f.turn('queued-native-response', 'running')
    f.db.markAsRead([message.id])
    expect((await target()).home).toEqual(RECEIVING_A)
    await f.turn('queued-native-response', 'completed')
    expect((await target()).home).toEqual(SELECTED_B)
    // Provider history replacement removes the old turn, not the result's delivery stamp.
    await f.journal.replaceEpochItems('handle_forked', 2, [])
    expect((await target()).home).toEqual(SELECTED_B)
  } finally {
    await f.dispose()
  }
})

it('withdrawal ends queued notice ownership even when the result remains unread', async () => {
  const f = await createReceivingAccountFixture()
  try {
    const message = f.finish(f.start())
    await f.journal.queuedMessages.insert({ messageId: 'withdrawn-pointer', body: f.body(message) })
    f.db.markAsDelivered([message.id], `run:${f.run.id}`)
    const target = () => structuredAgentSessionReceivingAccount(f.deps, f.record, f.session)
    expect((await target()).home).toEqual(RECEIVING_A)
    await f.journal.queuedMessages.withdraw(['withdrawn-pointer'])
    expect((await target()).home).toEqual(SELECTED_B)
    await f.journal.replaceEpochItems('handle_forked', 2, [])
    expect((await target()).home).toEqual(SELECTED_B)
  } finally {
    await f.dispose()
  }
})

it.each([10, 100])(
  'bounds queued native ownership updates at %i cards to the changed card',
  async (n) => {
    const f = await createReceivingAccountFixture()
    try {
      const started = performance.now()
      const ids: string[] = []
      for (let i = 0; i < n; i += 1) {
        const message = f.finish(f.start())
        const id = `pointer-${i}`
        ids.push(id)
        await f.journal.queuedMessages.insert({ messageId: id, body: f.body(message) })
        f.db.markAsDelivered([message.id], `run:${f.run.id}`)
      }
      const list = vi.spyOn(f.journal.queuedMessages, 'list')
      const get = vi.spyOn(f.journal.queuedMessages, 'get')
      const projection = new StructuredNativeResponses()
      expect([...projection.read(f.journal).pending]).toHaveLength(n)
      expect(list).toHaveBeenCalledTimes(1)
      for (let i = 0; i < n; i += 1) {
        expect([...projection.read(f.journal).pending]).toHaveLength(n)
      }
      expect(list).toHaveBeenCalledTimes(1)
      expect(get).not.toHaveBeenCalled()
      await f.journal.queuedMessages.withdraw([ids[0]])
      // Count the receiving projection, excluding the existing mutation owner's own lookups.
      list.mockClear()
      get.mockClear()
      expect([...projection.read(f.journal).pending]).toHaveLength(n - 1)
      expect(list).not.toHaveBeenCalled()
      expect(get).toHaveBeenCalledTimes(1)
      process.stdout.write(
        `receiving-account queue corpus=${n} initialLists=1 unchangedReads=${n} changedCardGets=1 changedCardLists=0 elapsedMs=${(performance.now() - started).toFixed(3)}\n`
      )
    } finally {
      await f.dispose()
    }
  }
)
