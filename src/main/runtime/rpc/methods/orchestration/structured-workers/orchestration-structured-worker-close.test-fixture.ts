import { expect, vi } from 'vitest'
import {
  hostTestAttachParams,
  hostTestOperationId
} from '../../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import type { JournalSqlReads } from '../../../../../native-chat/agent-session-journal/journal-sql-reads'
import type { SqlAgentSessionJournal } from '../../../../../native-chat/agent-session-journal/journal-sql-store'
import { hostTestState } from '../../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-host.test-fixture'

export function holdClose(sessionId: string) {
  const { host } = hostTestState()
  const lane = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const held = host.collaboratorsForTests().serialize(sessionId, () => lane.promise)
  const close = host.close
  vi.spyOn(host, 'close').mockImplementation((...args) => {
    entered.resolve()
    return close(...args)
  })
  return {
    entered: entered.promise,
    release: async () => {
      lane.resolve()
      await held
    }
  }
}

export function holdAdmissionReply(journal: SqlAgentSessionJournal) {
  const entered = Promise.withResolvers<void>()
  const reply = Promise.withResolvers<void>()
  const ordered = journal.readInOrder.bind(journal)
  let held = true
  vi.spyOn(journal, 'readInOrder').mockImplementation(function <T>(
    run: (reads: JournalSqlReads) => T | Promise<T>
  ): Promise<T> {
    return ordered((reads) =>
      run({
        ...reads,
        work: async (input) => {
          const answer = await reads.work(input)
          if (held) {
            held = false
            entered.resolve()
            await reply.promise
          }
          return answer
        }
      })
    )
  })
  return {
    entered: entered.promise,
    release: () => reply.resolve(),
    fail: () => reply.reject(new Error('work reader unavailable'))
  }
}

export async function reattach(sessionId: string) {
  const { host, store } = hostTestState()
  const result = await host.attach(
    { callerKey: 'redrive-test' },
    hostTestAttachParams(store.requireWritableRecord(sessionId).lease.runtimeFence, {
      envelope: {
        sessionId,
        clientOperationId: hostTestOperationId(),
        expectedRuntimeFence: store.requireWritableRecord(sessionId).lease.runtimeFence,
        payloadFingerprint: '0'.repeat(64)
      }
    })
  )
  expect(result.ok).toBe(true)
}
