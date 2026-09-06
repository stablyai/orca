import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import {
  InMemoryOrchestrationMessages,
  TEST_WORKTREE_ID,
  bindSinglePtyRun,
  setInMemoryOrchestrationMessages,
  store,
  syncSinglePty
} from '../orca-runtime-test-fixtures.spec'

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

      // Why: the push reads every pending row, not just the one that woke it. A
      // `status` notify is unclaimed and pushes, but the worker_done row landing
      // in the same drain belongs to this waiter's check — injecting it too would
      // deliver that completion twice (pane + check return).
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

      await expect(waitPromise).resolves.toBe('notified')
      await vi.advanceTimersByTimeAsync(600)
      const payloads = write.mock.calls
        .map(([, data]) => data)
        .filter((data): data is string => typeof data === 'string')
      expect(payloads).toContain(
        '\nYou have 1 orchestration message. Run `orca orchestration check --run run_test`.\n'
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
      // Why: the notify snapshot is empty — no waiter existed yet. A check that
      // blocks before the deferred push runs still owns this row, so only the
      // push-time read of live waiters can keep it out of the pane.
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
        kill: vi.fn(),
        getForegroundProcess: async () => null
      })
      // Why a UUID leaf id: the retirement fence's pty-candidate clause compares
      // parsePaneKey(pty.paneKey).leafId to the republished leafId, and a non-UUID
      // id falls back to `tabId:paneRuntimeId`, so it is always fenced after exit.
      const leafId = '11111111-1111-1111-8111-111111111111'
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
      // Drop the leaf, then republish it: the rebuilt record's tailSource is the
      // PTY record rather than the previous leaf, which is what pins the clear
      // onPtyExit applies at the pty level.
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

      // Why: syncWindowGraph rebuilds every leaf record on any pane/tab change.
      // An idle agent emits no new title, so dropping the live-status carry here
      // would strand mail until the next OSC frame — the #12536 symptom.
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
        kill: vi.fn(),
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime)

      const [terminal] = (await runtime.listTerminals()).terminals
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
      await runtime.waitForTerminal(terminal.handle, { condition: 'tui-idle' })
      write.mockClear()

      // Why: a cold restore respawns under the same session id and makes the
      // leaf writable again before any new title. The dead process's live idle
      // must not authorize typing into its replacement mid-turn.
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

      // The replacement's first live idle frame re-authorizes delivery — with no
      // working frame, since exit keeps lastAgentStatus 'idle' for `ps` and the
      // replacement can come up straight at an idle prompt (no transition).
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
        kill: vi.fn(),
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime)

      const [terminal] = (await runtime.listTerminals()).terminals
      const mailbox = bindSinglePtyRun(db, terminal.handle)
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
      await runtime.waitForTerminal(terminal.handle, { condition: 'tui-idle' })

      // Why: a `check --wait --types worker_done` waiter never returns a status
      // row — check re-reads under the same filter — so it is not the consumer
      // and treating it as one would strand the message (#12536).
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

      // The filtered waiter stays blocked; the push did not consume its wake.
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

      // Why: blocked orchestration.check --wait is an explicit pull; push must
      // not stamp delivered_at or type into the pane (double delivery, #12584).
      const waitPromise = runtime.waitForMessage(mailbox, { timeoutMs: 5_000 })
      runtime.notifyMessageArrived(terminal.handle, 'status')

      await expect(waitPromise).resolves.toBe('notified')
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
        ([, payload]) => typeof payload === 'string' && payload.includes('orca orchestration check')
      )
      expect(pointerWrites).toHaveLength(1)

      await vi.advanceTimersByTimeAsync(500)
      const enterWrites = write.mock.calls.filter(([, payload]) => payload === '\r')
      expect(enterWrites).toHaveLength(1)

      await vi.advanceTimersByTimeAsync(2_000)
      expect(
        write.mock.calls.filter(
          ([, payload]) =>
            typeof payload === 'string' && payload.includes('orca orchestration check')
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
      // Why the flush: the deferred push must actually arm its flight before the
      // second message arrives, or this exercises a plain batch instead.
      await Promise.resolve()

      // Why: mid-flight notify parks the leaf; flight settle re-runs delivery
      // so the second row is not lost and is not double-injected with the first.
      const second = db.insertMessage({ from: 'sender', to: terminal.handle, subject: 'second' })
      runtime.notifyMessageArrived(terminal.handle, 'status')
      await Promise.resolve()
      expect(
        write.mock.calls.filter(
          ([, payload]) =>
            typeof payload === 'string' && payload.includes('orca orchestration check')
        )
      ).toHaveLength(1)
      expect(second.delivered_at).toBeNull()

      // Why: release must not require another agent-status OSC — only the
      // delayed-Enter flight timer. Advancing 3s with no status output covers
      // timer-only settle (CodeRabbit settling-timeout gap, #12584).
      await vi.advanceTimersByTimeAsync(3_000)
      expect(write).toHaveBeenCalledWith('pty-1', '\r')
      expect(first.delivered_at).toEqual(expect.any(String))
      expect(
        write.mock.calls.filter(
          ([, payload]) =>
            typeof payload === 'string' && payload.includes('orca orchestration check')
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
    await expect(waitPromise).resolves.toBe('notified')
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

  it('allows only one exclusive mailbox waiter and supports explicit cancellation', async () => {
    const runtime = new OrcaRuntimeService(store)
    const first = runtime.waitForMessage('run:run_1', {
      timeoutMs: 5000,
      exclusive: true
    })

    await expect(
      runtime.waitForMessage('run:run_1', { timeoutMs: 5000, exclusive: true })
    ).resolves.toBe('waiter_exists')
    runtime.cancelMessageWaiters('run:run_1')
    await expect(first).resolves.toBe('cancelled')
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

  it('fails terminal waits closed when the handle goes stale during reload', async () => {
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

    await expect(waitPromise).rejects.toThrow('terminal_handle_stale')
  })
})
