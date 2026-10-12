// The retry's budget counts rounds, never collisions: many chats whose automatic sends meet one
// lock at once cost one failed round, not one each, and the work lands once the lock lifts.

import { afterEach, expect, it, vi } from 'vitest'
import * as reconciliationPass from './structured-agent-session-reconciliation-pass'
import {
  StructuredAgentSessionRetry,
  type StructuredAgentSessionRetryContext
} from './structured-agent-session-reconciliation-retry'
import { retryOwes } from './structured-agent-session-retry.test-fixture'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function settleTurns(): Promise<void> {
  for (let turn = 0; turn < 60; turn++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

it('ten chats whose automatic sends meet one lock cost one round, and send once it lifts', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.spyOn(reconciliationPass, 'runStructuredAgentSessionReconciliationPass').mockResolvedValue({
    failed: [],
    wrote: false,
    recovering: false
  })
  const ids = Array.from({ length: 10 }, (_, index) => `chat-${index}`)
  let locked = true
  const sendQueued = vi.fn(async () => (locked ? ('contended' as const) : ('done' as const)))
  const abandonSend = vi.fn()
  const context = {
    deps: {
      store: {
        onGenerationEnded: () => () => undefined,
        getRecord: () => ({ lease: { unreconciled: false, runtimeFence: 1 } }),
        listRecords: () => [],
        readOnly: false
      },
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }
    },
    sessions: new Map(
      ids.map((id) => [id, { journal: { openedAt: () => ({ epoch: 'e', sequence: 0 }) } }])
    ),
    now: () => 0,
    serialize: (_id: string, task: () => Promise<unknown>) => task(),
    laneBusy: () => false,
    track: (operation: Promise<unknown>) => operation,
    publishGenerationEnded: vi.fn(),
    reconcileOwed: () => false,
    reconcile: async () => 'settled' as const,
    sendQueued,
    abandonSend
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the retry reads only the fields above; the host's full deps would add nothing this test exercises.
  const typed = context as unknown as StructuredAgentSessionRetryContext
  const retry = new StructuredAgentSessionRetry(typed)

  // Each chat's own drain met the lock at the same moment.
  for (const id of ids) {
    retry.signal(id, { contended: true })
  }
  await settleTurns()
  // One round, ended by the first send that met the lock: one failure, nobody given up on.
  expect(sendQueued).toHaveBeenCalledTimes(1)
  expect(abandonSend).not.toHaveBeenCalled()
  expect(retry['failures']).toBe(1)

  locked = false
  await vi.advanceTimersByTimeAsync(2_000)
  await settleTurns()
  expect(sendQueued).toHaveBeenCalledTimes(11)
  expect(ids.filter((id) => retryOwes(retry, id))).toEqual([])
  expect(abandonSend).not.toHaveBeenCalled()
  retry.dispose()
})
