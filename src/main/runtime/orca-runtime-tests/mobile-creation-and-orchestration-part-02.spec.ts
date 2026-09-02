import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService, OrchestrationDb } from '../orca-runtime-test-mocks.spec'
import {
  InMemoryOrchestrationMessages,
  bindSinglePtyRun,
  pendingMailPointerRepoints,
  setInMemoryOrchestrationMessages,
  store,
  syncSinglePty
} from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('delivers pending mail via notifyMessageArrived when the recipient is already idle', async () => {
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
      const message = db.insertMessage({
        from: 'sender',
        to: terminal.handle,
        subject: 'after wait'
      })

      // Why: notifyMessageArrived is the send-path hook; it must push-on-idle
      // without requiring another agent-status transition (#12536).
      runtime.notifyMessageArrived(terminal.handle, 'status')

      // The push is deferred one microtask so it lands behind any resolved check.
      await Promise.resolve()
      expect(write).toHaveBeenCalledWith(
        'pty-1',
        expect.stringContaining('You have 1 orchestration message')
      )
      expect(write).not.toHaveBeenCalledWith('pty-1', expect.stringContaining('after wait'))
      await vi.advanceTimersByTimeAsync(500)
      expect(write).toHaveBeenCalledWith('pty-1', '\r')
      expect(message.delivered_at).toEqual(expect.any(String))
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('points a Run mailbox at its live-idle coordinator without replaying pending rows', async () => {
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
      db.setRun({
        id: 'run_mailbox',
        coordinator_handle: terminal.handle,
        coordinator_pane_key: `${terminal.tabId}:${terminal.leafId}`
      })
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      const message = db.insertMessage({
        from: 'term_worker',
        to: 'run:run_mailbox',
        subject: 'one P3 finding',
        body: 'private worker report',
        type: 'worker_done'
      })

      runtime.notifyMessageArrived('run:run_mailbox', 'worker_done')
      await Promise.resolve()
      expect(write).not.toHaveBeenCalled()

      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
      expect(write).toHaveBeenCalledWith(
        'pty-1',
        '\nYou have 1 orchestration message. Run `orca orchestration check --run run_mailbox`.\n'
      )
      expect(write).not.toHaveBeenCalledWith(
        'pty-1',
        expect.stringContaining('private worker report')
      )
      await vi.advanceTimersByTimeAsync(500)
      expect(write).toHaveBeenCalledWith('pty-1', '\r')
      expect(message.delivered_at).toEqual(expect.any(String))

      runtime.notifyMessageArrived('run:run_mailbox', 'worker_done')
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(500)
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

  it('repoints worker_done when a stale waiter wakes without consuming it', async () => {
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

      await expect(staleWait).resolves.toBe('notified')
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
          ([, payload]) =>
            typeof payload === 'string' && payload.includes('orca orchestration check')
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

  it('repoints on the retry edge when live idle won the send race', async () => {
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
      db.insertMessage({
        from: 'term_worker',
        to: terminal.handle,
        subject: 'settled at idle edge',
        type: 'worker_done'
      })
      runtime.notifyMessageArrived(terminal.handle, 'worker_done')
      await Promise.resolve()
      expect(write).not.toHaveBeenCalled()

      const leaf = [
        ...(
          runtime as unknown as {
            leaves: Map<
              string,
              { lastAgentStatus: string | null; lastAgentStatusObservedLive: boolean }
            >
          }
        ).leaves.values()
      ][0]
      leaf.lastAgentStatus = 'idle'
      leaf.lastAgentStatusObservedLive = true

      await vi.advanceTimersByTimeAsync(2_000)
      expect(write).toHaveBeenCalledWith(
        'pty-1',
        expect.stringContaining('You have 1 orchestration message')
      )
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves later delivery to the idle edge instead of polling a working mailbox', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const db = new InMemoryOrchestrationMessages()
      const pendingReads = vi.spyOn(db, 'getUndeliveredUnreadMessages')
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
      db.insertMessage({
        from: 'term_worker',
        to: terminal.handle,
        subject: 'wait for idle'
      })
      runtime.notifyMessageArrived(terminal.handle, 'status')
      await Promise.resolve()

      await vi.advanceTimersByTimeAsync(20_000)
      expect(pendingReads).not.toHaveBeenCalled()
      expect(pendingMailPointerRepoints(runtime)).toBe(0)

      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
      expect(pendingReads).toHaveBeenCalledTimes(1)
      expect(write).toHaveBeenCalledWith(
        'pty-1',
        expect.stringContaining('You have 1 orchestration message')
      )
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('points restored mail when a live-idle PTY remounts after the repair edge', async () => {
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
      bindSinglePtyRun(db, terminal.handle)
      runtime.registerPreAllocatedHandleForPty('pty-1', terminal.handle)
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
      runtime.markRendererReloading(1)
      db.insertMessage({
        from: 'term_worker',
        to: terminal.handle,
        subject: 'restored'
      })
      setInMemoryOrchestrationMessages(runtime, db)

      await vi.advanceTimersByTimeAsync(2_000)
      expect(write).not.toHaveBeenCalled()

      syncSinglePty(runtime)
      expect(write).toHaveBeenCalledWith(
        'pty-1',
        expect.stringContaining('You have 1 orchestration message')
      )
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not keep retrying when every pending row was already pointed', async () => {
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
      db.insertMessage({
        from: 'term_worker',
        to: terminal.handle,
        subject: 'once'
      })
      runtime.notifyMessageArrived(terminal.handle, 'status')
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(2_500)

      expect(
        write.mock.calls.filter(
          ([, payload]) =>
            typeof payload === 'string' && payload.includes('orca orchestration check')
        )
      ).toHaveLength(1)
      expect(pendingMailPointerRepoints(runtime)).toBe(0)
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('repoints pending rows restored with a live-idle coordinator', async () => {
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
      bindSinglePtyRun(db, terminal.handle)
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
      db.insertMessage({
        from: 'term_worker',
        to: terminal.handle,
        subject: 'survived restart',
        type: 'worker_done'
      })
      write.mockClear()

      setInMemoryOrchestrationMessages(runtime, db)
      await vi.advanceTimersByTimeAsync(2_000)

      expect(write).toHaveBeenCalledWith(
        'pty-1',
        expect.stringContaining('You have 1 orchestration message')
      )
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops a pending repoint after its database closes', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const db = new OrchestrationDb(':memory:')
      const write = vi.fn().mockReturnValue(true)
      runtime.setOrchestrationDb(db)
      runtime.setPtyController({
        write,
        kill: vi.fn(),
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime)

      const [terminal] = (await runtime.listTerminals()).terminals
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      db.insertMessage({ from: 'term_worker', to: terminal.handle, subject: 'pending' })
      runtime.notifyMessageArrived(terminal.handle, 'status')
      db.close()

      await vi.advanceTimersByTimeAsync(2_000)
      expect(write).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('points already-idle Run mail after Codex replaces its completion title', async () => {
    const runtime = new OrcaRuntimeService(store)
    const db = new InMemoryOrchestrationMessages()
    const write = vi.fn().mockReturnValue(true)
    setInMemoryOrchestrationMessages(runtime, db)
    runtime.setPtyController({
      write,
      kill: vi.fn(),
      getForegroundProcess: async () => 'codex'
    })
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    db.setRun({
      id: 'run_codex_native_title',
      coordinator_handle: terminal.handle,
      coordinator_pane_key: `${terminal.tabId}:${terminal.leafId}`
    })
    runtime.ingestSyntheticTitleFrame('pty-1', '\x1b]0;Codex ready\x07')
    runtime.onPtyData('pty-1', '\x1b]0;fix-12953-orchestration-mail-pointer\x07', 101)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    db.insertMessage({
      from: 'term_worker',
      to: 'run:run_codex_native_title',
      subject: 'real-agent smoke complete',
      body: 'The package name is orca.',
      type: 'worker_done'
    })

    runtime.notifyMessageArrived('run:run_codex_native_title', 'worker_done')
    await Promise.resolve()

    await vi.waitFor(() => {
      expect(write).toHaveBeenCalledWith(
        'pty-1',
        '\nYou have 1 orchestration message. Run `orca orchestration check --run run_codex_native_title`.\n'
      )
    })
    db.close()
  })

  it('does not inject pending mail on notify when the recipient is still working', async () => {
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
    const message = db.insertMessage({
      from: 'sender',
      to: terminal.handle,
      subject: 'while working'
    })
    write.mockClear()

    runtime.notifyMessageArrived(terminal.handle, 'status')
    await Promise.resolve()

    expect(write).not.toHaveBeenCalled()
    // Why: busy must leave the row undelivered so a later idle can push it;
    // a stamp-without-write would suppress later delivery (#12584 CodeRabbit).
    expect(message.delivered_at).toBeNull()
    db.close()
  })

  it('delivers on a first live idle frame that follows a seeded idle with no transition', async () => {
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
      runtime.seedTerminalRestoreTail('pty-1', { lastTitle: 'Codex done' })
      const message = db.insertMessage({
        from: 'sender',
        to: terminal.handle,
        subject: 'restored idle'
      })
      runtime.notifyMessageArrived(terminal.handle, 'status')
      await Promise.resolve()
      write.mockClear()

      // Why no working frame: a resumed agent sitting at its prompt emits an
      // already-idle title first. The seed left lastAgentStatus 'idle', so there
      // is no transition — only the liveness edge can release the row (#12536).
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 100)

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

  it('does not push on a cold-restore seeded idle status with no live observation', async () => {
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
      // Why: the persisted title is historical — the agent may have gone busy
      // across the relaunch, so a seeded 'idle' must not authorize a PTY write.
      runtime.seedTerminalRestoreTail('pty-1', { lastTitle: 'Codex done' })
      const message = db.insertMessage({
        from: 'sender',
        to: terminal.handle,
        subject: 'seeded idle'
      })
      write.mockClear()

      runtime.notifyMessageArrived(terminal.handle, 'status')
      await Promise.resolve()

      expect(write).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(600)
      expect(message.delivered_at).toBeNull()

      // The first live idle frame authorizes it and the row still delivers.
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
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

  it('lets a resolved check consume its rows before a later same-tick notify pushes', async () => {
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

      // Why: resolveMessageWaiter removes the waiter synchronously, but the check
      // handler marks its rows read a microtask later. Two sends resuming off one
      // shared in-flight promise put a no-waiter notify inside that window, so the
      // push must not inject rows the resolved check is about to return.
      const consumed = runtime
        .waitForMessage(mailbox, { timeoutMs: 5_000 })
        .then(() => db.getUnreadMessages(mailbox).map((row) => (row.read = 1)))
      const first = db.insertMessage({ from: 'sender', to: terminal.handle, subject: 'pulled' })
      runtime.notifyMessageArrived(terminal.handle, 'status')
      const second = db.insertMessage({
        from: 'sender',
        to: terminal.handle,
        subject: 'also pulled'
      })
      runtime.notifyMessageArrived(terminal.handle, 'status')

      await consumed
      await Promise.resolve()
      expect(write).not.toHaveBeenCalled()
      expect(first.delivered_at).toBeNull()
      expect(second.delivered_at).toBeNull()
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })
})
