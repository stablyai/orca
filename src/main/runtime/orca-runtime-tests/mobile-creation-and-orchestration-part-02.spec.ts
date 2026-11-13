import { settledWriteStub } from '../../providers/testing/settled-pty-write-stub'
import { describe, expect, it, vi } from 'vitest'
import './runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'

import {
  setInMemoryOrchestrationMessages,
  store,
  syncSinglePty
} from './orca-runtime-test-fixtures.spec'
import { InMemoryOrchestrationMessages } from '../orchestration/mailbox/terminal-pointer/in-memory-orchestration-messages.spec'
import { MessageWake } from '../orchestration/mailbox/runtime-message-waiters'

describe('OrcaRuntimeService', () => {
  it('repoints worker_done when a stale waiter wakes without consuming it', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const db = new InMemoryOrchestrationMessages()
      const write = vi.fn().mockReturnValue(true)
      setInMemoryOrchestrationMessages(runtime, db)
      runtime.setPtyController({
        write,
        writeWithSettlement: settledWriteStub(write),
        kill: vi.fn(),
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime)

      const [terminal] = (await runtime.listTerminals()).terminals
      db.setRun({
        id: 'run_stale_waiter',
        coordinator_handle: terminal.handle,
        coordinator_pane_key: `${terminal.tabId}:${terminal.leafId}`
      })
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
      write.mockClear()

      const staleWait = runtime.waitForMessage('run:run_stale_waiter', {
        typeFilter: ['worker_done'],
        timeoutMs: 60_000
      })
      db.insertMessage({
        from: 'term_final_worker',
        to: 'run:run_stale_waiter',
        subject: 'final worker settled',
        type: 'worker_done'
      })
      runtime.notifyMessageArrived('run:run_stale_waiter', 'worker_done')

      await expect(staleWait).resolves.toBeInstanceOf(MessageWake)
      expect(write).not.toHaveBeenCalled()

      db.insertMessage({
        from: 'term_other_worker',
        to: 'run:run_stale_waiter',
        subject: 'newer status',
        type: 'status'
      })
      runtime.deliverPendingMessagesForHandle('run:run_stale_waiter', new Set(['worker_done']))
      await vi.advanceTimersByTimeAsync(500)

      const pointers = () =>
        write.mock.calls.filter(
          ([, payload]) => typeof payload === 'string' && payload.includes('orchestration check')
        )
      expect(pointers()).toHaveLength(1)
      expect(pointers()[0]?.[1]).toContain('You have 1 orchestration message')

      await vi.advanceTimersByTimeAsync(1_500)
      expect(pointers()).toHaveLength(2)
      expect(pointers()[1]?.[1]).toContain('You have 1 orchestration message')
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  // Mail follows the terminal: a window reload does not hold a live-idle terminal's restored mail.
})
