import { settledWriteStub } from '../../providers/settled-pty-write-stub'
import { describe, expect, it, vi } from 'vitest'
import { registerLivePty } from '../bind-first-pane.test-fixture'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import {
  InMemoryOrchestrationMessages,
  TEST_WORKTREE_ID,
  bindSinglePtyRun,
  setInMemoryOrchestrationMessages,
  store,
  syncSinglePty
} from '../orca-runtime-test-fixtures.spec'
import { MessageWake } from '../runtime-message-waiters'

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
      expect(payloads).toContain(
        '\nYou have 1 orchestration message. Run `orca-dev orchestration check --run run_test`.\n'
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

  it('does not carry pty-record live authority into a rebuilt leaf after a same-id respawn', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const db = new InMemoryOrchestrationMessages()
      const write = vi.fn().mockReturnValue(true)
      runtime.setPtyController({
        write,
        writeWithSettlement: settledWriteStub(write),
        kill: vi.fn(),
        getForegroundProcess: async () => null
      })
      // Non-UUID leaves fall back to tab:paneRuntimeId and are always exit-fenced; use UUID to exercise exact retirement.
      const leafId = '11111111-1111-1111-8111-111111111111'
      registerLivePty(runtime, 'pty-1', TEST_WORKTREE_ID, null, { tabId: 'tab-1', leafId })
      const syncUuidLeaf = (): void => {
        runtime.attachWindow(1)
        runtime.syncWindowGraph(1, {
          tabs: [
            {
              tabId: 'tab-1',
              worktreeId: TEST_WORKTREE_ID,
              title: 'Codex',
              activeLeafId: leafId,
              layout: null
            }
          ],
          leaves: [
            {
              tabId: 'tab-1',
              worktreeId: TEST_WORKTREE_ID,
              leafId,
              paneRuntimeId: 1,
              ptyId: 'pty-1',
              paneTitle: null
            }
          ]
        })
      }
      syncUuidLeaf()

      const [terminal] = (await runtime.listTerminals()).terminals
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
      await runtime.waitForTerminal(terminal.handle, { condition: 'tui-idle' })
      write.mockClear()

      runtime.onPtyExit('pty-1', 0)
      runtime.onPtySpawned('pty-1', undefined, { awaitsRegistration: false })
      registerLivePty(runtime, 'pty-1', TEST_WORKTREE_ID, null, { tabId: 'tab-1', leafId })
      // Rebuild without the previous leaf so PTY-level tail clearing is tested.
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      syncUuidLeaf()

      const leaves = (
        runtime as unknown as {
          leaves: Map<
            string,
            { lastAgentStatus: string | null; lastAgentStatusObservedLive: boolean }
          >
        }
      ).leaves
      expect(leaves.size).toBeGreaterThan(0)
      const rebuilt = [...leaves.values()][0]
      expect(rebuilt.lastAgentStatus).toBe('idle')
      expect(rebuilt.lastAgentStatusObservedLive).toBe(false)

      setInMemoryOrchestrationMessages(runtime, db)
      const [republished] = (await runtime.listTerminals()).terminals
      bindSinglePtyRun(db, republished.handle)
      const message = db.insertMessage({
        from: 'sender',
        to: republished.handle,
        subject: 'rebuilt leaf'
      })
      runtime.notifyMessageArrived(republished.handle, 'status')
      await Promise.resolve()

      expect(write).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(600)
      expect(message.delivered_at).toBeNull()
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps live idle authority across a renderer graph republish', async () => {
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
      bindSinglePtyRun(db, terminal.handle)
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
      await runtime.waitForTerminal(terminal.handle, { condition: 'tui-idle' })
      write.mockClear()

      // Graph rebuilds must retain live idle or mail waits forever for another OSC frame (#12536).
      syncSinglePty(runtime)

      const [republished] = (await runtime.listTerminals()).terminals
      const message = db.insertMessage({
        from: 'sender',
        to: republished.handle,
        subject: 'after republish'
      })

      runtime.notifyMessageArrived(republished.handle, 'status')
      await Promise.resolve()

      expect(write).toHaveBeenCalledWith(
        'pty-1',
        expect.stringContaining('You have 1 orchestration message')
      )
      await vi.advanceTimersByTimeAsync(600)
      expect(message.delivered_at).toEqual(expect.any(String))
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not reuse the dead process live idle authority after a same-id respawn', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const db = new InMemoryOrchestrationMessages()
      const write = vi.fn().mockReturnValue(true)
      runtime.setPtyController({
        write,
        writeWithSettlement: settledWriteStub(write),
        kill: vi.fn(),
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime)

      const [terminal] = (await runtime.listTerminals()).terminals
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
      await runtime.waitForTerminal(terminal.handle, { condition: 'tui-idle' })
      write.mockClear()

      // Same-id respawn is writable before new status; dead-process idle must never authorize replacement writes.
      runtime.onPtyExit('pty-1', 0)
      runtime.onPtySpawned('pty-1', undefined, { awaitsRegistration: false })
      setInMemoryOrchestrationMessages(runtime, db)
      bindSinglePtyRun(db, terminal.handle)
      const message = db.insertMessage({
        from: 'sender',
        to: terminal.handle,
        subject: 'after same id respawn'
      })

      runtime.notifyMessageArrived(terminal.handle, 'status')
      await Promise.resolve()

      expect(write).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(600)
      expect(message.delivered_at).toBeNull()

      // Replacement can start idle with no transition; its first live idle evidence must reauthorize delivery.
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 200)
      expect(write).toHaveBeenCalledWith(
        'pty-1',
        expect.stringContaining('You have 1 orchestration message')
      )
      await vi.advanceTimersByTimeAsync(600)
      expect(message.delivered_at).toEqual(expect.any(String))
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('pushes to an idle pane when the only live waiter filters out the message type', async () => {
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

      // worker_done-filtered waiters cannot consume status rows and must not suppress their idle push (#12536).
      const waitPromise = runtime.waitForMessage(mailbox, {
        typeFilter: ['worker_done'],
        timeoutMs: 5_000
      })
      const message = db.insertMessage({
        from: 'sender',
        to: terminal.handle,
        subject: 'unfiltered status',
        type: 'status'
      })
      write.mockClear()

      runtime.notifyMessageArrived(terminal.handle, 'status')

      await Promise.resolve()
      expect(write).toHaveBeenCalledWith(
        'pty-1',
        expect.stringContaining('You have 1 orchestration message')
      )
      await vi.advanceTimersByTimeAsync(600)
      expect(message.delivered_at).toEqual(expect.any(String))

      await vi.advanceTimersByTimeAsync(5_000)
      await expect(waitPromise).resolves.toBe('timed_out')
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('resolves a registered waiter without PTY-injecting when the leaf is already idle', async () => {
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
      const message = db.insertMessage({
        from: 'sender',
        to: terminal.handle,
        subject: 'for check wait'
      })
      write.mockClear()

      // Explicit check --wait owns delivery; push must neither stamp nor type those rows (#12584).
      const waitPromise = runtime.waitForMessage(mailbox, { timeoutMs: 5_000 })
      runtime.notifyMessageArrived(terminal.handle, 'status')

      await expect(waitPromise).resolves.toBeInstanceOf(MessageWake)
      expect(write).not.toHaveBeenCalled()
      expect(message.delivered_at).toBeNull()
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not re-inject the same message when notify fires again during Enter delay', async () => {
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
      bindSinglePtyRun(db, terminal.handle)
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
      await runtime.waitForTerminal(terminal.handle, { condition: 'tui-idle' })
      db.insertMessage({ from: 'sender', to: terminal.handle, subject: 'once only' })

      runtime.notifyMessageArrived(terminal.handle, 'status')
      await Promise.resolve()
      runtime.notifyMessageArrived(terminal.handle, 'status')
      await Promise.resolve()

      const pointerWrites = write.mock.calls.filter(
        ([, payload]) => typeof payload === 'string' && payload.includes('orchestration check')
      )
      expect(pointerWrites).toHaveLength(1)

      await vi.advanceTimersByTimeAsync(500)
      const enterWrites = write.mock.calls.filter(([, payload]) => payload === '\r')
      expect(enterWrites).toHaveLength(1)

      await vi.advanceTimersByTimeAsync(2_000)
      expect(
        write.mock.calls.filter(
          ([, payload]) => typeof payload === 'string' && payload.includes('orchestration check')
        )
      ).toHaveLength(1)
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('delivers a second message parked during Enter delay once the flight settles', async () => {
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
      bindSinglePtyRun(db, terminal.handle)
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
      await runtime.waitForTerminal(terminal.handle, { condition: 'tui-idle' })
      const first = db.insertMessage({ from: 'sender', to: terminal.handle, subject: 'first' })
      runtime.notifyMessageArrived(terminal.handle, 'status')
      // Arm the first flight before the next message, or this tests ordinary batching.
      await Promise.resolve()

      // Mid-flight notify must retry after settlement without losing or duplicating the second row.
      const second = db.insertMessage({ from: 'sender', to: terminal.handle, subject: 'second' })
      runtime.notifyMessageArrived(terminal.handle, 'status')
      await Promise.resolve()
      expect(
        write.mock.calls.filter(
          ([, payload]) => typeof payload === 'string' && payload.includes('orchestration check')
        )
      ).toHaveLength(1)
      expect(second.delivered_at).toBeNull()

      // Delayed-Enter settlement alone must retry mail; no further agent OSC is required (#12584).
      await vi.advanceTimersByTimeAsync(3_000)
      expect(write).toHaveBeenCalledWith('pty-1', '\r')
      expect(first.delivered_at).toEqual(expect.any(String))
      expect(
        write.mock.calls.filter(
          ([, payload]) => typeof payload === 'string' && payload.includes('orchestration check')
        )
      ).toHaveLength(2)
      expect(write).toHaveBeenCalledWith(
        'pty-1',
        expect.stringContaining('You have 1 orchestration message')
      )
      expect(second.delivered_at).toEqual(expect.any(String))
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps already-idle status after tui-idle wait for immediate message delivery', async () => {
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
    bindSinglePtyRun(db, terminal.handle)
    runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
    runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
    await runtime.waitForTerminal(terminal.handle, { condition: 'tui-idle' })
    db.insertMessage({ from: 'sender', to: terminal.handle, subject: 'after wait' })

    runtime.deliverPendingMessagesForHandle(terminal.handle)

    expect(write).toHaveBeenCalledWith(
      'pty-1',
      expect.stringContaining('You have 1 orchestration message')
    )
    db.close()
  })

  it('resolves message waiters when notifyMessageArrived is called', async () => {
    const runtime = new OrcaRuntimeService(store)

    const waitPromise = runtime.waitForMessage('term_abc', { timeoutMs: 5000 })
    runtime.notifyMessageArrived('term_abc')
    await expect(waitPromise).resolves.toBeInstanceOf(MessageWake)
  })

  it('does not resolve type-filtered message waiters for unrelated message types', async () => {
    const runtime = new OrcaRuntimeService(store)

    const waitPromise = runtime.waitForMessage('term_abc', {
      typeFilter: ['worker_done', 'escalation'],
      timeoutMs: 5000
    })
    let settled = false
    void waitPromise.then(() => {
      settled = true
    })

    runtime.notifyMessageArrived('term_abc', 'heartbeat')
    await Promise.resolve()

    expect(settled).toBe(false)

    runtime.notifyMessageArrived('term_abc', 'worker_done')
    await waitPromise
    expect(settled).toBe(true)
  })

  it('removes message waiter abort listeners after message arrival', async () => {
    const runtime = new OrcaRuntimeService(store)
    const controller = new AbortController()
    const removeListenerSpy = vi.spyOn(controller.signal, 'removeEventListener')

    const waitPromise = runtime.waitForMessage('term_abc', {
      timeoutMs: 5000,
      signal: controller.signal
    })
    runtime.notifyMessageArrived('term_abc')
    await waitPromise

    expect(removeListenerSpy).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('resolves message waiters on timeout when no message arrives', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const wait = runtime.waitForMessage('term_abc', { timeoutMs: 100 })

      await vi.advanceTimersByTimeAsync(99)
      let settled = false
      void wait.then(() => {
        settled = true
      })
      await Promise.resolve()
      expect(settled).toBe(false)

      await vi.advanceTimersByTimeAsync(1)
      await expect(wait).resolves.toBe('timed_out')
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
