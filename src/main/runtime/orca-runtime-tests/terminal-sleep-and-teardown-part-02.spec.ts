import { describe, expect, it, vi } from 'vitest'
import {
  MOCK_GIT_WORKTREES,
  OrcaRuntimeService,
  listWorktrees
} from '../orca-runtime-test-mocks.spec'
import type { RuntimeClientEvent } from '../orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  TEST_REPO_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  deferred,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal,
  store
} from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('does not stop a provider-owned foreign PTY referenced by stale target state', async () => {
    const otherWorktreePath = '/tmp/worktree-b'
    const otherWorktreeId = `${TEST_REPO_ID}::${otherWorktreePath}`
    vi.mocked(listWorktrees).mockResolvedValue([
      ...MOCK_GIT_WORKTREES,
      {
        path: otherWorktreePath,
        head: 'def',
        branch: 'feature/other',
        isBare: false,
        isMainWorktree: false
      }
    ])
    const session = makeWorkspaceSessionWithHeadlessTerminal()
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...session,
      terminalLayoutsByTabId: {
        'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: 'pty-foreign' })
      }
    })
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const stopAndWait = vi.fn(async () => true)
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'pty-foreign',
          cwd: otherWorktreePath,
          title: 'Other',
          worktreeId: otherWorktreeId
        }
      ]
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'stale-tab',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Stale',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'stale-tab',
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-foreign'
        }
      ]
    })

    const projectedTarget = (await runtime.getWorktreePs()).worktrees.find(
      (worktree) => worktree.worktreeId === TEST_WORKTREE_ID
    )
    expect(projectedTarget).toMatchObject({ liveTerminalCount: 0, hasAttachedPty: false })

    await expect(runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)).resolves.toEqual({
      stopped: 0,
      stoppedPtyIds: [],
      livePtyIds: [],
      postStopVerified: true
    })
    expect(stopAndWait).not.toHaveBeenCalled()
  })

  it('fails closed for an unresolved explicit foreign provider owner', async () => {
    const session = makeWorkspaceSessionWithHeadlessTerminal()
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...session,
      terminalLayoutsByTabId: {
        'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: 'opaque-foreign-pty' })
      }
    })
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const stopAndWait = vi.fn(async () => true)
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'opaque-foreign-pty',
          cwd: TEST_WORKTREE_PATH,
          title: 'Other',
          worktreeId: `${TEST_REPO_ID}::/temporarily-unresolved-foreign-worktree`
        }
      ]
    })

    await expect(
      runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
    ).resolves.toMatchObject({ stopped: 0, postStopVerified: true })
    expect(stopAndWait).not.toHaveBeenCalled()
  })

  it('reports a PTY that remains live after acknowledged worktree sleep', async () => {
    const runtime = new OrcaRuntimeService(store)
    const liveProcess = { id: 'pty-1', cwd: TEST_WORKTREE_PATH, title: 'Claude' }
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait: vi.fn(async () => true),
      getForegroundProcess: async () => null,
      listProcesses: async () => [liveProcess]
    })

    await expect(runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)).resolves.toEqual({
      stopped: 1,
      stoppedPtyIds: ['pty-1'],
      livePtyIds: ['pty-1'],
      postStopVerified: false,
      postStopFailure: 'terminal_worktree_sleep_still_live',
      remainingLivePtyIds: ['pty-1']
    })
  })

  it('reports unavailable post-stop liveness instead of assuming convergence', async () => {
    const runtime = new OrcaRuntimeService(store)
    const clientEvents: RuntimeClientEvent[][] = [[], []]
    for (const events of clientEvents) {
      runtime.onClientEvent((event) => events.push(event))
    }
    let listCount = 0
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait: async (ptyId) => {
        runtime.onPtyExit(ptyId, -1)
        return true
      },
      getForegroundProcess: async () => null,
      listProcesses: async () => {
        listCount += 1
        if (listCount === 2) {
          throw new Error('daemon unavailable')
        }
        return listCount === 1 ? [{ id: 'pty-1', cwd: TEST_WORKTREE_PATH, title: 'Claude' }] : []
      }
    })

    await expect(runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)).resolves.toEqual({
      stopped: 1,
      stoppedPtyIds: ['pty-1'],
      livePtyIds: ['pty-1'],
      postStopVerified: false,
      postStopFailure: 'terminal_liveness_unavailable'
    })
    await expect(
      runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
    ).resolves.toMatchObject({ stopped: 0, postStopVerified: true })
    for (const events of clientEvents) {
      expect(
        events
          .filter(
            (event): event is Extract<RuntimeClientEvent, { type: 'worktreeTerminalSleepState' }> =>
              event.type === 'worktreeTerminalSleepState'
          )
          .filter((event) => event.phase === 'committed')
          .flatMap((event) => event.ptyIds)
      ).toContain('pty-1')
      expect(
        events.some(
          (event) => event.type === 'worktreeTerminalSleepState' && event.phase === 'cancelled'
        )
      ).toBe(false)
    }
  })

  it('coalesces two clients sleeping the same host worktree', async () => {
    const runtime = new OrcaRuntimeService(store)
    const initialInventory = deferred<{ id: string; cwd: string; title: string }[]>()
    const listProcesses = vi
      .fn()
      .mockImplementationOnce(() => initialInventory.promise)
      .mockResolvedValueOnce([])
    const stopAndWait = vi.fn(async (ptyId: string) => {
      runtime.onPtyExit(ptyId, -1)
      return true
    })
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait,
      getForegroundProcess: async () => null,
      listProcesses
    })

    const first = runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
    const second = runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
    initialInventory.resolve([{ id: 'pty-1', cwd: TEST_WORKTREE_PATH, title: 'Claude' }])

    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(secondResult).toEqual(firstResult)
    expect(stopAndWait).toHaveBeenCalledTimes(1)
    expect(listProcesses).toHaveBeenCalledTimes(2)
  })

  it('serializes a new terminal spawn behind physical sleep convergence', async () => {
    const runtime = new OrcaRuntimeService(store)
    const stop = deferred<boolean>()
    const events: RuntimeClientEvent[] = []
    runtime.onClientEvent((event) => events.push(event))
    const listProcesses = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'pty-before-sleep', cwd: TEST_WORKTREE_PATH, title: 'Shell' }])
      .mockResolvedValueOnce([])
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait: async (ptyId) => {
        const result = await stop.promise
        runtime.onPtyExit(ptyId, -1)
        return result
      },
      getForegroundProcess: async () => null,
      listProcesses
    })

    const sleep = runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
    await vi.waitFor(() => expect(listProcesses).toHaveBeenCalledTimes(1))
    expect(runtime.getTerminalSleepClientEventSnapshot()).toEqual([
      expect.objectContaining({ phase: 'started', ptyIds: ['pty-before-sleep'] })
    ])
    let spawnLeaseAcquired = false
    const spawnLease = runtime.acquireWorktreeTerminalSpawn(TEST_WORKTREE_ID).then((release) => {
      spawnLeaseAcquired = true
      return release
    })
    await Promise.resolve()
    expect(spawnLeaseAcquired).toBe(false)

    stop.resolve(true)
    await expect(sleep).resolves.toMatchObject({ postStopVerified: true })
    const releaseSpawn = await spawnLease
    expect(spawnLeaseAcquired).toBe(true)
    releaseSpawn()
    expect(runtime.getTerminalSleepClientEventSnapshot()).toEqual([])
    expect(
      events
        .filter((event) => event.type === 'worktreeTerminalSleepState')
        .map((event) => event.phase)
    ).toEqual(['started', 'committed', 'woken'])
  })

  it('waits for an in-flight spawn before inventorying worktree sleep', async () => {
    const runtime = new OrcaRuntimeService(store)
    const listProcesses = vi.fn().mockResolvedValue([])
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait: vi.fn(async () => true),
      getForegroundProcess: async () => null,
      listProcesses
    })
    const releaseSpawn = await runtime.acquireWorktreeTerminalSpawn(TEST_WORKTREE_ID)

    const sleep = runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
    await Promise.resolve()
    expect(listProcesses).not.toHaveBeenCalled()
    releaseSpawn()

    await expect(sleep).resolves.toMatchObject({ stopped: 0, postStopVerified: true })
    expect(listProcesses).toHaveBeenCalledTimes(1)
  })

  it('expires while queued behind a spawn and never stops it later', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const listProcesses = vi.fn().mockResolvedValue([])
      const stopAndWait = vi.fn(async () => true)
      runtime.setPtyController({
        write: () => true,
        kill: () => false,
        stopAndWait,
        getForegroundProcess: async () => null,
        listProcesses
      })
      const releaseSpawn = await runtime.acquireWorktreeTerminalSpawn(TEST_WORKTREE_ID)

      const sleep = runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
      const rejection = expect(sleep).rejects.toThrow('terminal_worktree_sleep_timeout')
      await vi.advanceTimersByTimeAsync(12_001)
      await rejection
      releaseSpawn()
      await Promise.resolve()

      expect(listProcesses).not.toHaveBeenCalled()
      expect(stopAndWait).not.toHaveBeenCalled()
      const releaseNextSpawn = await runtime.acquireWorktreeTerminalSpawn(TEST_WORKTREE_ID)
      releaseNextSpawn()
    } finally {
      vi.useRealTimers()
    }
  })

  it('releases the worktree terminal mutation when a wake client-event listener throws', async () => {
    const runtime = new OrcaRuntimeService(store)
    const secondListenerEvents: RuntimeClientEvent[] = []
    // Why: a broken paired-client relay can throw synchronously while delivering the wake
    // notification. That must not abort the wake or (regression) leak the per-worktree terminal
    // mutation acquired in acquireWorktreeTerminalSpawn, or every later sleep wedges for 12s.
    runtime.onClientEvent((event) => {
      if (event.type === 'worktreeTerminalSleepState' && event.phase === 'woken') {
        throw new Error('relay_send_failed')
      }
    })
    runtime.onClientEvent((event) => secondListenerEvents.push(event))
    const processLists = [[{ id: 'pty-1', cwd: TEST_WORKTREE_PATH, title: 'Claude' }], [], []]
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait: async (ptyId) => {
        runtime.onPtyExit(ptyId, -1)
        return true
      },
      getForegroundProcess: async () => null,
      listProcesses: async () => processLists.shift() ?? []
    })

    // Sleep leaves the worktree in a 'sleeping' state so the next spawn emits the 'woken' event.
    await runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)

    // The wake acquires the mutation and emits 'woken'; a throwing subscriber must not surface.
    const releaseSpawn = await runtime.acquireWorktreeTerminalSpawn(TEST_WORKTREE_ID)
    releaseSpawn()

    // Isolation: the second subscriber still received the 'woken' event.
    expect(
      secondListenerEvents.some(
        (event) => event.type === 'worktreeTerminalSleepState' && event.phase === 'woken'
      )
    ).toBe(true)

    // Regression: the mutation was released, so a subsequent sleep converges instead of throwing
    // terminal_worktree_sleep_timeout.
    await expect(
      runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
    ).resolves.toMatchObject({ postStopVerified: true })
  })

  it('isolates a throwing subscriber across runtime listener fan-out', () => {
    const runtime = new OrcaRuntimeService(store)
    const delivered: number[] = []
    // Why: the shared notifyRuntimeListeners guard must let sibling fan-outs (here mobile
    // notifications) survive a throwing subscriber, not just the client-event path.
    runtime.onNotificationDispatched(() => {
      throw new Error('subscriber_send_failed')
    })
    runtime.onNotificationDispatched((event) => {
      delivered.push(event.notificationSeq ?? -1)
    })

    expect(() =>
      runtime.dispatchMobileNotification({
        type: 'notification',
        source: 'test',
        title: 'Test',
        body: 'Body',
        worktreeId: TEST_WORKTREE_ID
      })
    ).not.toThrow()

    // The second subscriber still received the event despite the first throwing.
    expect(delivered).toHaveLength(1)
  })

  it('keeps the original committed disposition across an idempotent retry', async () => {
    const runtime = new OrcaRuntimeService(store)
    const events: RuntimeClientEvent[] = []
    runtime.onClientEvent((event) => events.push(event))
    const processLists = [
      [{ id: 'pty-preserved-history', cwd: TEST_WORKTREE_PATH, title: 'Shell' }],
      [],
      []
    ]
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait: async (ptyId) => {
        runtime.onPtyExit(ptyId, -1)
        return true
      },
      getForegroundProcess: async () => null,
      listProcesses: async () => processLists.shift() ?? []
    })

    await runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
    expect(runtime.getTerminalSleepClientEventSnapshot()).toEqual([
      expect.objectContaining({ phase: 'committed', ptyIds: ['pty-preserved-history'] })
    ])
    await runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
    const releaseSpawn = await runtime.acquireWorktreeTerminalSpawn(TEST_WORKTREE_ID)
    releaseSpawn()

    const sleepEvents = events.filter((event) => event.type === 'worktreeTerminalSleepState')
    expect(sleepEvents.map((event) => event.phase)).toEqual(['started', 'committed', 'woken'])
    expect(sleepEvents.at(-1)?.ptyIds).toEqual(['pty-preserved-history'])
  })

  it('keeps concurrent sleep coalesced until every launched stop settles', async () => {
    const runtime = new OrcaRuntimeService(store)
    const clientEvents: RuntimeClientEvent[][] = [[], []]
    for (const events of clientEvents) {
      runtime.onClientEvent((event) => events.push(event))
    }
    const secondStop = deferred<boolean>()
    const failedPty = { id: 'pty-fails', cwd: TEST_WORKTREE_PATH, title: 'Claude' }
    const listProcesses = vi
      .fn()
      .mockResolvedValueOnce([
        failedPty,
        { id: 'pty-slow', cwd: TEST_WORKTREE_PATH, title: 'Shell' }
      ])
      .mockResolvedValueOnce([failedPty])
      .mockResolvedValueOnce([failedPty])
      .mockResolvedValueOnce([])
    let failedAttempts = 0
    const stopAndWait = vi.fn(async (ptyId: string) => {
      if (ptyId === 'pty-fails') {
        failedAttempts += 1
        if (failedAttempts === 1) {
          throw new Error('stop failed')
        }
        runtime.onPtyExit(ptyId, -1)
        return true
      }
      const stopped = await secondStop.promise
      runtime.onPtyExit(ptyId, -1)
      return stopped
    })
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait,
      getForegroundProcess: async () => null,
      listProcesses
    })

    const first = runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
    await vi.waitFor(() => expect(stopAndWait).toHaveBeenCalledTimes(2))
    const concurrent = runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
    secondStop.resolve(true)

    await expect(first).rejects.toThrow('terminal_worktree_sleep_failed')
    await expect(concurrent).rejects.toThrow('terminal_worktree_sleep_failed')
    expect(runtime.getTerminalSleepClientEventSnapshot()).toEqual([
      expect.objectContaining({ phase: 'committed', ptyIds: ['pty-slow'] })
    ])
    await expect(
      runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
    ).resolves.toMatchObject({ postStopVerified: true, stoppedPtyIds: ['pty-fails'] })
    expect(stopAndWait).toHaveBeenCalledTimes(3)
    for (const events of clientEvents) {
      const sleepEvents = events.filter(
        (event): event is Extract<RuntimeClientEvent, { type: 'worktreeTerminalSleepState' }> =>
          event.type === 'worktreeTerminalSleepState'
      )
      expect(
        [
          ...new Set(
            sleepEvents
              .filter((event) => event.phase === 'committed')
              .flatMap((event) => event.ptyIds)
          )
        ].sort()
      ).toEqual(['pty-fails', 'pty-slow'])
      expect(
        sleepEvents.filter((event) => event.phase === 'cancelled').flatMap((event) => event.ptyIds)
      ).toEqual(['pty-fails'])
    }
  })

  it('stops exactly the expected live PTYs for a worktree', async () => {
    const runtime = new OrcaRuntimeService(store)
    const stopped: string[] = []
    const processLists = [[{ id: 'pty-1', cwd: '/tmp/worktree-a', title: 'Claude' }], []]
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait: async (ptyId, opts) => {
        stopped.push(ptyId)
        expect(opts).toEqual({ keepHistory: true })
        runtime.onPtyExit(ptyId, -1)
        return true
      },
      getForegroundProcess: async () => null,
      listProcesses: async () => processLists.shift() ?? []
    })

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

    await expect(
      runtime.stopExactTerminalsForWorktree('id:repo-1::/tmp/worktree-a', ['pty-1'], {
        keepHistory: true
      })
    ).resolves.toEqual({
      stopped: 1,
      stoppedPtyIds: ['pty-1'],
      livePtyIds: ['pty-1'],
      postStopVerified: true
    })
    expect(stopped).toEqual(['pty-1'])
  })

  it('reports recoverable post-stop liveness failure after exact terminal stop', async () => {
    const runtime = new OrcaRuntimeService(store)
    const stopped: string[] = []
    const processLists = [
      [{ id: 'pty-1', cwd: '/tmp/worktree-a', title: 'Claude' }],
      new Error('daemon unavailable')
    ]
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait: async (ptyId) => {
        stopped.push(ptyId)
        runtime.onPtyExit(ptyId, -1)
        return true
      },
      getForegroundProcess: async () => null,
      listProcesses: async () => {
        const next = processLists.shift()
        if (next instanceof Error) {
          throw next
        }
        return next ?? []
      }
    })

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

    await expect(
      runtime.stopExactTerminalsForWorktree('id:repo-1::/tmp/worktree-a', ['pty-1'])
    ).resolves.toEqual({
      stopped: 1,
      stoppedPtyIds: ['pty-1'],
      livePtyIds: ['pty-1'],
      postStopVerified: false,
      postStopFailure: 'terminal_liveness_unavailable'
    })
    expect(stopped).toEqual(['pty-1'])
  })
})
