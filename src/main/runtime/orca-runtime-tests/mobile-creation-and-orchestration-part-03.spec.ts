import { settledWriteStub } from '../../providers/testing/settled-pty-write-stub'
import { describe, expect, it, vi } from 'vitest'

import './runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import {
  bindSinglePtyRun,
  setInMemoryOrchestrationMessages,
  store,
  syncSinglePty
} from './orca-runtime-test-fixtures.spec'
import { InMemoryOrchestrationMessages } from '../orchestration/mailbox/terminal-pointer/in-memory-orchestration-messages.spec'
import { MessageWake } from '../orchestration/mailbox/runtime-message-waiters'

describe('OrcaRuntimeService', () => {
  it('leaves rows a live filtered waiter reserved out of the pushed batch', async () => {
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
      const mailbox = bindSinglePtyRun(db, terminal.handle)
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
      await runtime.waitForTerminal(terminal.handle, { condition: 'tui-idle' })
      write.mockClear()

      // Push scans all pending rows; exclude worker_done owned by the blocked check or it delivers twice.
      const waitPromise = runtime.waitForMessage(mailbox, {
        typeFilter: ['worker_done'],
        timeoutMs: 5_000
      })
      const status = db.insertMessage({
        from: 'sender',
        to: terminal.handle,
        subject: 'unclaimed status',
        type: 'status'
      })
      runtime.notifyMessageArrived(terminal.handle, 'status')
      const done = db.insertMessage({
        from: 'sender',
        to: terminal.handle,
        subject: 'reserved completion',
        type: 'worker_done'
      })
      runtime.notifyMessageArrived(terminal.handle, 'worker_done')

      await expect(waitPromise).resolves.toBeInstanceOf(MessageWake)
      await vi.advanceTimersByTimeAsync(600)
      const payloads = write.mock.calls
        .map(([, data]) => data)
        .filter((data): data is string => typeof data === 'string')
      expect(write).toHaveBeenCalledWith(
        'pty-1',
        '\nYou have 1 orchestration message. Run orca-dev orchestration check --run run_test.\n'
      )
      expect(payloads.some((data) => data.includes('reserved completion'))).toBe(false)
      expect(status.delivered_at).toEqual(expect.any(String))
      expect(done.delivered_at).toBeNull()
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('skips rows claimed by a waiter that registered after the notify', async () => {
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
      const mailbox = bindSinglePtyRun(db, terminal.handle)
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
      await runtime.waitForTerminal(terminal.handle, { condition: 'tui-idle' })
      write.mockClear()

      const message = db.insertMessage({
        from: 'sender',
        to: terminal.handle,
        subject: 'claimed late',
        type: 'status'
      })
      // A waiter arriving after notify still owns rows before deferred push; consult live waiters at push time.
      runtime.notifyMessageArrived(terminal.handle, 'status')
      const waitPromise = runtime.waitForMessage(mailbox, {
        typeFilter: ['status'],
        timeoutMs: 5_000
      })
      await Promise.resolve()

      expect(write).not.toHaveBeenCalled()
      expect(message.delivered_at).toBeNull()

      await vi.advanceTimersByTimeAsync(5_000)
      await expect(waitPromise).resolves.toBe('timed_out')
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects leaf PTY waits when the request signal aborts', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const controller = new AbortController()

      const waitPromise = runtime
        .waitForLeafPtyId('missing-handle', 60_000, controller.signal)
        .then(() => 'resolved')
        .catch((error: Error) => error.message)

      controller.abort()
      const outcomePromise = Promise.race([
        waitPromise,
        new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 0))
      ])
      await vi.advanceTimersByTimeAsync(0)

      expect(await outcomePromise).toBe('request_aborted')
    } finally {
      vi.useRealTimers()
    }
  })

  // #24354: a wait follows its terminal, which a renderer reload does not end.
  it('keeps a terminal wait across a renderer reload until the terminal exits', async () => {
    const runtime = new OrcaRuntimeService(store)

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Claude',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })

    const [terminal] = (await runtime.listTerminals()).terminals
    const waitPromise = runtime.waitForTerminal(terminal.handle, { timeoutMs: 1000 })
    runtime.markRendererReloading(1)
    await runtime.onPtyExit('pty-1', 0)

    await expect(waitPromise).resolves.toMatchObject({ condition: 'exit', exitCode: 0 })
  })
})
