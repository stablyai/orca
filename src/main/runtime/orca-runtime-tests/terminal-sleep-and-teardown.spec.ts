import { describe, expect, it, vi } from 'vitest'
import {
  MOCK_GIT_WORKTREES,
  OrcaRuntimeService,
  WORKTREE_PROCESS_SWEEP_TIMEOUT_MS,
  WORKTREE_TEARDOWN_RPC_MARGIN_MS,
  listWorktrees
} from '../orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  TEST_REPO_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  makeDeferred,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal,
  store,
  syncSinglePty
} from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('shows worktree.ps working when the current pane supersedes a Claude agents OSC title', async () => {
    const runtime = new OrcaRuntimeService(store)

    syncSinglePty(runtime, 'pty-1', { paneTitle: 'claude agents' })
    runtime.onPtyData('pty-1', '\x1b]0;claude agents\x07', 100)
    syncSinglePty(runtime, 'pty-1', { paneTitle: 'claude working' })

    const summary = await runtime.getWorktreePs()

    expect(summary.worktrees[0].status).toBe('working')
  })

  it('fails terminal stop closed while the renderer graph is reloading', async () => {
    const runtime = new OrcaRuntimeService(store)
    let killed = false
    runtime.setPtyController({
      write: () => true,
      kill: () => {
        killed = true
        return true
      },
      getForegroundProcess: async () => null
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
    runtime.markRendererReloading(1)

    await expect(runtime.stopTerminalsForWorktree('id:repo-1::/tmp/worktree-a')).rejects.toThrow(
      'runtime_unavailable'
    )
    expect(killed).toBe(false)
  })

  it('stops by exact id when the selector no longer resolves', async () => {
    const runtime = new OrcaRuntimeService(store)
    const kill = vi.fn(() => true)
    runtime.setPtyController({
      write: () => true,
      kill,
      stopAndWait: vi.fn(async () => true),
      getForegroundProcess: async () => null
    })
    syncSinglePty(runtime)

    // An orphaned workspace's repo is gone, so only the caller's id can identify it.
    await expect(
      runtime.stopTerminalsForWorktree('id:repo-gone::/tmp/gone', {
        resolvedWorktreeId: TEST_WORKTREE_ID
      })
    ).resolves.toEqual({ stopped: 1 })
    expect(kill).toHaveBeenCalledWith('pty-1')
  })

  it('does not sweep a sibling workspace sharing the checkout dir of an exact id', async () => {
    const runtime = new OrcaRuntimeService(store)
    const kill = vi.fn(() => true)
    runtime.setPtyController({
      write: () => true,
      kill,
      stopAndWait: vi.fn(async () => true),
      getForegroundProcess: async () => null
    })
    syncSinglePty(runtime)

    // Regression for #10252: folder-workspace instances share one checkout dir, so comparing
    // filesystem paths (which strip `::workspace:<uuid>`) would match the root and its siblings
    // and kill their live terminals.
    await expect(
      runtime.stopTerminalsForWorktree('id:repo-gone::/tmp/gone', {
        resolvedWorktreeId: `${TEST_WORKTREE_ID}::workspace:11111111-1111-1111-1111-111111111111`
      })
    ).resolves.toEqual({ stopped: 0 })
    expect(kill).not.toHaveBeenCalled()
  })

  it('does not sweep a same-id terminal owned by another connection', async () => {
    const runtime = new OrcaRuntimeService(store)
    const kill = vi.fn(() => true)
    runtime.setPtyController({
      write: () => true,
      kill,
      stopAndWait: vi.fn(async () => true),
      getForegroundProcess: async () => null
    })
    syncSinglePty(runtime)

    await expect(
      runtime.stopTerminalsForWorktree('id:repo-gone::/tmp/gone', {
        resolvedWorktreeId: TEST_WORKTREE_ID,
        resolvedConnectionId: 'ssh-1'
      })
    ).resolves.toEqual({ stopped: 0 })
    expect(kill).not.toHaveBeenCalled()
  })

  it('stops only the owning connection when one worktree id lives on two hosts', async () => {
    const runtime = new OrcaRuntimeService(store)
    const kill = vi.fn(() => true)
    runtime.setPtyController({
      write: () => true,
      kill,
      stopAndWait: vi.fn(async () => true),
      getForegroundProcess: async () => null
    })
    syncSinglePty(runtime, null)
    // The store keeps one `repoId::path` per host, so deleting the SSH copy must leave the
    // local copy's terminals running — the fence the destructive removal paths now supply.
    runtime.registerPty('pty-ssh', TEST_WORKTREE_ID, 'ssh-1')
    runtime.registerPty('pty-local', TEST_WORKTREE_ID, null)

    await expect(
      runtime.stopTerminalsForWorktree(TEST_WORKTREE_ID, {
        resolvedWorktreeId: TEST_WORKTREE_ID,
        resolvedConnectionId: 'ssh-1'
      })
    ).resolves.toEqual({ stopped: 1 })
    expect(kill).toHaveBeenCalledWith('pty-ssh')
    expect(kill).not.toHaveBeenCalledWith('pty-local')
  })

  it('awaits physical PTY stop when destructive teardown supplies shared dedupe', async () => {
    const runtime = new OrcaRuntimeService(store)
    const physicalStop = makeDeferred()
    const kill = vi.fn(() => true)
    const stopAndWait = vi.fn(async () => {
      await physicalStop.promise
      return true
    })
    runtime.setPtyController({
      write: () => true,
      kill,
      stopAndWait,
      getForegroundProcess: async () => null
    })
    syncSinglePty(runtime)
    const stopPty = vi.fn(async (_ptyId: string, stop: () => boolean | Promise<boolean>) => ({
      stopped: await stop(),
      owner: true
    }))

    const stopping = runtime.stopTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`, { stopPty })
    await vi.waitFor(() => expect(stopAndWait).toHaveBeenCalledWith('pty-1'))
    expect(kill).not.toHaveBeenCalled()
    let settled = false
    void stopping.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    physicalStop.resolve()
    await expect(stopping).resolves.toEqual({ stopped: 1 })
  })

  it('passes a margin-adjusted RPC deadline into stopAndWait for destructive teardown', async () => {
    const runtime = new OrcaRuntimeService(store)
    const stopAndWait = vi.fn(async () => true)
    runtime.setPtyController({
      write: () => true,
      kill: vi.fn(() => true),
      stopAndWait,
      getForegroundProcess: async () => null
    })
    syncSinglePty(runtime)
    const stopPty = vi.fn(async (_ptyId: string, stop: () => boolean | Promise<boolean>) => ({
      stopped: await stop(),
      owner: true
    }))

    // Why: the runtime-graph sweep must bound the underlying shutdown/list RPCs
    // below the sweep deadline, or a wedged daemon trips the outer sweep deadline.
    const deadline = Date.now() + WORKTREE_PROCESS_SWEEP_TIMEOUT_MS
    await expect(
      runtime.stopTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`, { deadline, stopPty })
    ).resolves.toEqual({ stopped: 1 })

    expect(stopAndWait).toHaveBeenCalledTimes(1)
    const [ptyId, opts] = stopAndWait.mock.calls[0] as unknown as [
      string,
      { deadlineMs?: number } | undefined
    ]
    expect(ptyId).toBe('pty-1')
    // Pin the margin: RPCs must settle WORKTREE_TEARDOWN_RPC_MARGIN_MS before the
    // sweep deadline so the accurate stop failure outruns the sweep-timeout error.
    expect(opts?.deadlineMs).toBe(deadline - WORKTREE_TEARDOWN_RPC_MARGIN_MS)
  })

  it('fails terminal listing closed if the graph reloads during selector resolution', async () => {
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

    let releaseListWorktrees = () => {}
    vi.mocked(listWorktrees).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseListWorktrees = () => resolve(MOCK_GIT_WORKTREES)
        })
    )

    const listPromise = runtime.listTerminals('branch:feature/foo')
    runtime.markRendererReloading(1)
    releaseListWorktrees()

    await expect(listPromise).rejects.toThrow('runtime_unavailable')
  })

  it('fails terminal stop closed if the graph reloads during selector resolution', async () => {
    const runtime = new OrcaRuntimeService(store)
    let killed = false
    runtime.setPtyController({
      write: () => true,
      kill: () => {
        killed = true
        return true
      },
      getForegroundProcess: async () => null
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

    let releaseListWorktrees = () => {}
    vi.mocked(listWorktrees).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseListWorktrees = () => resolve(MOCK_GIT_WORKTREES)
        })
    )

    const stopPromise = runtime.stopTerminalsForWorktree('branch:feature/foo')
    runtime.markRendererReloading(1)
    releaseListWorktrees()

    await expect(stopPromise).rejects.toThrow('runtime_unavailable')
    expect(killed).toBe(false)
  })

  it('does not stop a reused PTY after the teardown deadline passes', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const killed = vi.fn(() => true)
      runtime.setPtyController({
        write: () => true,
        kill: killed,
        getForegroundProcess: async () => null
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
            ptyId: 'reused-pty'
          }
        ]
      })

      let releaseListWorktrees = () => {}
      vi.mocked(listWorktrees).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseListWorktrees = () => resolve(MOCK_GIT_WORKTREES)
          })
      )
      const stopPromise = runtime.stopTerminalsForWorktree('branch:feature/foo', {
        deadline: Date.now() + 25
      })

      await vi.advanceTimersByTimeAsync(25)
      releaseListWorktrees()

      await expect(stopPromise).resolves.toEqual({ stopped: 0 })
      expect(killed).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('sleeps every freshly discovered worktree PTY without a hydrated renderer graph', async () => {
    const runtime = new OrcaRuntimeService(store)
    const stopped: string[] = []
    const processLists = [
      [
        { id: 'pty-1', cwd: TEST_WORKTREE_PATH, title: 'Claude' },
        { id: 'pty-2', cwd: TEST_WORKTREE_PATH, title: 'Shell' }
      ],
      []
    ]
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait: async (ptyId, opts) => {
        stopped.push(ptyId)
        expect(opts).toEqual(
          expect.objectContaining({ keepHistory: true, deadlineMs: expect.any(Number) })
        )
        runtime.onPtyExit(ptyId, -1)
        return true
      },
      getForegroundProcess: async () => null,
      listProcesses: async () => processLists.shift() ?? []
    })

    await expect(runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)).resolves.toEqual({
      stopped: 2,
      stoppedPtyIds: ['pty-1', 'pty-2'],
      livePtyIds: ['pty-1', 'pty-2'],
      postStopVerified: true
    })
    expect(stopped).toEqual(['pty-1', 'pty-2'])
  })

  it('uses provider-owned worktree identity when a PTY cwd has drifted', async () => {
    const runtime = new OrcaRuntimeService(store)
    const stopAndWait = vi.fn(async (ptyId: string) => {
      runtime.onPtyExit(ptyId, -1)
      return true
    })
    const processLists = [
      [
        {
          id: 'opaque-pty-id',
          cwd: '/tmp/outside-the-worktree',
          title: 'Shell',
          worktreeId: TEST_WORKTREE_ID
        }
      ],
      []
    ]
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait,
      getForegroundProcess: async () => null,
      listProcesses: async () => processLists.shift() ?? []
    })

    await expect(
      runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
    ).resolves.toMatchObject({ stoppedPtyIds: ['opaque-pty-id'], postStopVerified: true })
    expect(stopAndWait).toHaveBeenCalledWith(
      'opaque-pty-id',
      expect.objectContaining({ keepHistory: true, deadlineMs: expect.any(Number) })
    )
  })

  it('sleeps a Windows-equivalent provider worktree identity after one request', async () => {
    const windowsPath = 'C:\\Repo\\Feature'
    const windowsWorktreeId = `${TEST_REPO_ID}::${windowsPath}`
    vi.mocked(listWorktrees).mockResolvedValue([
      ...MOCK_GIT_WORKTREES,
      {
        path: windowsPath,
        head: 'windows-head',
        branch: 'feature/windows',
        isBare: false,
        isMainWorktree: false
      }
    ])
    const runtime = new OrcaRuntimeService(store)
    const processLists = [
      [
        {
          id: 'windows-pty',
          cwd: 'C:/REPO/FEATURE',
          title: 'Shell',
          worktreeId: `${TEST_REPO_ID}::c:/repo/feature`
        }
      ],
      []
    ]
    const stopAndWait = vi.fn(async (ptyId: string) => {
      runtime.onPtyExit(ptyId, -1)
      return true
    })
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait,
      getForegroundProcess: async () => null,
      listProcesses: async () => processLists.shift() ?? []
    })

    await expect(
      runtime.sleepTerminalsForWorktree(`id:${windowsWorktreeId}`)
    ).resolves.toMatchObject({ stoppedPtyIds: ['windows-pty'], postStopVerified: true })
    expect(stopAndWait).toHaveBeenCalledWith(
      'windows-pty',
      expect.objectContaining({ keepHistory: true, deadlineMs: expect.any(Number) })
    )
  })

  it('prefers migrated persisted ownership over a provider worktree id frozen at spawn', async () => {
    const priorWorktreeId = `${TEST_REPO_ID}::/tmp/worktree-before-rename`
    const migratedPtyId = `${priorWorktreeId}@@daemon-controller-pty`
    const session = makeWorkspaceSessionWithHeadlessTerminal()
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...session,
      terminalLayoutsByTabId: {
        'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: migratedPtyId })
      }
    })
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const processLists = [
      [
        {
          id: migratedPtyId,
          cwd: '/tmp/outside-the-worktree',
          title: 'Shell',
          worktreeId: priorWorktreeId
        }
      ],
      []
    ]
    const stopAndWait = vi.fn(async (ptyId: string) => {
      runtime.onPtyExit(ptyId, -1)
      return true
    })
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait,
      getForegroundProcess: async () => null,
      listProcesses: async () => processLists.shift() ?? []
    })

    await expect(
      runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
    ).resolves.toMatchObject({ stoppedPtyIds: [migratedPtyId], postStopVerified: true })
    expect(stopAndWait).toHaveBeenCalledWith(
      migratedPtyId,
      expect.objectContaining({ keepHistory: true, deadlineMs: expect.any(Number) })
    )
  })

  it('treats an already-sleeping worktree as a verified idempotent success', async () => {
    const runtime = new OrcaRuntimeService(store)
    const stopAndWait = vi.fn(async () => true)
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })

    const first = await runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
    const retry = await runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)

    expect(first).toEqual({
      stopped: 0,
      stoppedPtyIds: [],
      livePtyIds: [],
      postStopVerified: true
    })
    expect(retry).toEqual(first)
    expect(stopAndWait).not.toHaveBeenCalled()
  })

  it('fails worktree sleep closed when fresh host liveness is unavailable', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait: vi.fn(async () => true),
      getForegroundProcess: async () => null,
      listProcesses: async () => {
        throw new Error('daemon unavailable')
      }
    })

    await expect(runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)).rejects.toThrow(
      'terminal_liveness_unavailable'
    )
  })

  it('surfaces physical worktree PTY stop failure', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait: vi.fn(async () => false),
      getForegroundProcess: async () => null,
      listProcesses: async () => [{ id: 'pty-1', cwd: TEST_WORKTREE_PATH, title: 'Claude' }]
    })

    await expect(runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)).rejects.toThrow(
      'terminal_worktree_sleep_failed'
    )
  })

  it('stops only PTYs owned by the selected worktree', async () => {
    const otherWorktreePath = '/tmp/worktree-b'
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
    const runtime = new OrcaRuntimeService(store)
    const stopped: string[] = []
    const otherPty = { id: 'pty-other', cwd: otherWorktreePath, title: 'Other' }
    const processLists = [
      [{ id: 'pty-target', cwd: TEST_WORKTREE_PATH, title: 'Target' }, otherPty],
      [otherPty]
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
      listProcesses: async () => processLists.shift() ?? [otherPty]
    })

    await expect(
      runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
    ).resolves.toMatchObject({ stoppedPtyIds: ['pty-target'], postStopVerified: true })
    expect(stopped).toEqual(['pty-target'])
  })
})
