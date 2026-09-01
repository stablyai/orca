import { describe, expect, it, vi } from 'vitest'
import {
  OrcaRuntimeService,
  getDefaultWorkspaceSession,
  registerSshGitProvider,
  setPlatform,
  win32,
  worktreePathComparison
} from '../orca-runtime-test-mocks.spec'
import type { WorktreeMeta } from '../orca-runtime-test-mocks.spec'
import {
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal,
  makeWorktreeMeta,
  store
} from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('keeps a retained OSC row from an SSH pane after its PTY disconnects', async () => {
    // Why: OSC snapshots must carry the pane transport; hardcoding local would
    // strip the SSH exemption off rows whose freshest update arrived via OSC.
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {}
    })
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime['recordPtyWorktree']('ssh-osc-pty', TEST_WORKTREE_ID, {
      connected: true,
      connectionId: 'ssh-osc-1',
      tabId: 'ssh-tab',
      paneKey: 'ssh-tab:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    })
    runtime.onPtyData(
      'ssh-osc-pty',
      '\x1b]9999;{"state":"working","prompt":"remote osc agent","agentType":"codex"}\x07',
      1
    )
    runtime['recordPtyWorktree']('ssh-osc-pty', TEST_WORKTREE_ID, { connected: false })

    const { worktrees } = await runtime.getWorktreePs()
    const summary = worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)

    expect(summary?.agents).toEqual([expect.objectContaining({ prompt: 'remote osc agent' })])
  })

  it('keeps a hook row with an unresolvable pane key', async () => {
    // Why: no tabId means staleness is unprovable; the filter must pass it.
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {}
    })
    const now = Date.now()
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey: 'opaque-key-without-structure',
          worktreeId: TEST_WORKTREE_ID,
          state: 'working',
          prompt: 'unattributable pane',
          agentType: 'codex',
          connectionId: null,
          receivedAt: now,
          stateStartedAt: now - 100
        }
      ]
    })

    const { worktrees } = await runtime.getWorktreePs()
    const summary = worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)

    expect(summary?.agents).toEqual([expect.objectContaining({ prompt: 'unattributable pane' })])
  })

  it('keeps a WSL hook row while its tab is still in the session', async () => {
    // Guards the WSL clause against over-filtering: local-tab evidence must
    // rescue WSL rows exactly like null-connection rows.
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'open-wsl-tab',
            ptyId: null,
            worktreeId: TEST_WORKTREE_ID,
            title: 'Codex',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      }
    })
    const now = Date.now()
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey: 'open-wsl-tab:99999999-9999-4999-8999-999999999997',
          worktreeId: TEST_WORKTREE_ID,
          tabId: 'open-wsl-tab',
          state: 'working',
          prompt: 'live in WSL',
          agentType: 'codex',
          connectionId: 'wsl:Ubuntu',
          receivedAt: now,
          stateStartedAt: now - 100
        }
      ]
    })

    const { worktrees } = await runtime.getWorktreePs()
    const summary = worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)

    expect(summary?.agents).toEqual([expect.objectContaining({ prompt: 'live in WSL' })])
  })

  it('drops a hydrated WSL hook row after its local tab is closed', async () => {
    // Why: WSL relay ids are transport provenance; the pane remains local.
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {}
    })
    const now = Date.now()
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey: 'closed-wsl-tab:99999999-9999-4999-8999-999999999999',
          worktreeId: TEST_WORKTREE_ID,
          tabId: 'closed-wsl-tab',
          state: 'done',
          prompt: 'finished in WSL',
          agentType: 'codex',
          connectionId: 'wsl:Ubuntu',
          receivedAt: now,
          stateStartedAt: now - 60_000
        }
      ]
    })

    const { worktrees } = await runtime.getWorktreePs()
    const summary = worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)

    expect(summary?.agents).toEqual([])
  })

  it('keeps remote hook rows whose tabs are only tracked on the remote host', async () => {
    // Why: the local session partition for an SSH host can be empty while the
    // remote host owns the terminals; absence there is not proof of a close.
    const remoteRepo = {
      id: 'repo-ssh-6072',
      path: '/home/me/project',
      displayName: 'remote-vm',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-6072'
    }
    const remoteWorktree = {
      path: '/home/me/project/.worktrees/feature-agents',
      head: 'def',
      branch: 'refs/heads/feature/agents',
      isBare: false,
      isMainWorktree: false
    }
    const remoteWorktreeId = `${remoteRepo.id}::${remoteWorktree.path}`
    const metaById: Record<string, WorktreeMeta> = {
      [remoteWorktreeId]: makeWorktreeMeta({ displayName: 'Remote agents' })
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === remoteRepo.id ? remoteRepo : undefined),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      getWorkspaceSession: () => getDefaultWorkspaceSession()
    }
    registerSshGitProvider('ssh-6072', {
      listWorktrees: vi.fn().mockResolvedValue([remoteWorktree])
    } as never)
    const now = Date.now()
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey: 'remote-tab:88888888-8888-4888-8888-888888888888',
          worktreeId: remoteWorktreeId,
          tabId: 'remote-tab',
          state: 'working',
          prompt: 'remote agent without local tab records',
          agentType: 'codex',
          connectionId: 'ssh-6072',
          receivedAt: now,
          stateStartedAt: now - 100
        }
      ]
    })

    const { worktrees } = await runtime.getWorktreePs()
    const summary = worktrees.find((worktree) => worktree.worktreeId === remoteWorktreeId)

    expect(summary?.agents).toEqual([
      expect.objectContaining({ prompt: 'remote agent without local tab records' })
    ])
  })

  it('marks the desktop-active worktree as isActive', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal()
    )
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    const { worktrees } = await runtime.getWorktreePs()
    const active = worktrees.filter((w) => w.isActive)
    expect(active).toHaveLength(1)
    expect(active[0]?.worktreeId).toBe(TEST_WORKTREE_ID)
  })

  it('includes SSH-backed worktrees in the mobile worktree summary', async () => {
    const remoteRepo = {
      id: 'repo-ssh',
      path: '/home/me/project',
      displayName: 'remote-vm',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1'
    }
    const remoteWorktree = {
      path: '/home/me/project/.worktrees/feature-mobile',
      head: 'def',
      branch: 'refs/heads/feature/mobile',
      isBare: false,
      isMainWorktree: false
    }
    const metaById: Record<string, WorktreeMeta> = {
      [`${remoteRepo.id}::${remoteWorktree.path}`]: makeWorktreeMeta({
        displayName: 'Remote mobile'
      })
    }
    const getRepo = vi.fn((id: string) => (id === remoteRepo.id ? remoteRepo : undefined))
    const runtimeStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    registerSshGitProvider('ssh-1', {
      listWorktrees: vi.fn().mockResolvedValue([remoteWorktree])
    } as never)

    const now = Date.now()
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      getAgentStatusSnapshot: () =>
        Array.from({ length: 100 }, (_, index) => ({
          paneKey: `remote-tab:${String(index).padStart(8, '0')}-5555-4555-8555-555555555555`,
          worktreeId: `${remoteRepo.id}::${remoteWorktree.path}/`,
          tabId: 'remote-tab',
          state: 'working',
          prompt: 'remote agent without a PTY',
          agentType: 'codex',
          connectionId: 'ssh-1',
          receivedAt: now,
          stateStartedAt: now - 100
        }))
    })
    const summaries = await runtime.getWorktreePs()

    // Why: equal keys prove polled worktree.ps rows can share the per-request index instead of repeating path scans.
    expect(worktreePathComparison.worktreePathComparisonKey(remoteWorktree.path, 'linux')).toBe(
      worktreePathComparison.worktreePathComparisonKey(`${remoteWorktree.path}/`, 'linux')
    )

    expect(summaries.worktrees).toEqual([
      expect.objectContaining({
        worktreeId: `${remoteRepo.id}::${remoteWorktree.path}`,
        repoId: remoteRepo.id,
        repo: 'remote-vm',
        path: remoteWorktree.path,
        displayName: 'Remote mobile',
        hasHostSidebarActivity: true,
        status: 'working',
        agents: expect.arrayContaining([
          expect.objectContaining({
            prompt: 'remote agent without a PTY',
            agentType: 'codex'
          })
        ])
      })
    ])
    expect(summaries.worktrees[0]?.agents).toHaveLength(100)
    expect(getRepo).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['relative', 'project', 'feature\\name', 'feature/name', 'feature\\name', true],
    [
      'absolute',
      'C:\\remote',
      '/remote/feature\\name',
      '/remote/feature/name',
      '/remote/feature\\name',
      true
    ],
    ['Windows SSH alias', 'C:\\remote', 'feature\\name', 'feature/name', 'feature/name', false]
  ] as const)(
    'handles %s worktree paths when projecting mobile agents',
    async (_kind, repoPath, backslashPath, slashPath, projectedPath, includeSlashWorktree) => {
      setPlatform('win32')
      const remoteRepo = {
        id: 'repo-relative-ssh',
        path: repoPath,
        displayName: 'relative-vm',
        badgeColor: 'blue',
        addedAt: 1,
        connectionId: 'ssh-relative'
      }
      const backslashWorktree = {
        path: backslashPath,
        head: 'abc',
        branch: 'refs/heads/backslash',
        isBare: false,
        isMainWorktree: false
      }
      const slashWorktree = {
        ...backslashWorktree,
        path: slashPath,
        branch: 'refs/heads/slash'
      }
      const runtimeStore = {
        ...store,
        getRepos: () => [remoteRepo],
        getRepo: (id: string) => (id === remoteRepo.id ? remoteRepo : undefined),
        getAllWorktreeMeta: () => ({}),
        getWorktreeMeta: () => undefined
      }
      registerSshGitProvider('ssh-relative', {
        listWorktrees: vi
          .fn()
          .mockResolvedValue(
            includeSlashWorktree ? [backslashWorktree, slashWorktree] : [backslashWorktree]
          )
      } as never)

      const now = Date.now()
      const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
        getAgentStatusSnapshot: () =>
          Array.from({ length: 100 }, (_, index) => ({
            paneKey: `relative-tab:${String(index).padStart(8, '0')}-5555-4555-8555-555555555555`,
            worktreeId: `${remoteRepo.id}::${projectedPath}/`,
            tabId: 'relative-tab',
            state: 'working',
            prompt: 'relative path agent',
            agentType: 'codex',
            connectionId: 'ssh-relative',
            receivedAt: now,
            stateStartedAt: now - 100
          }))
      })

      const summaries = await runtime.getWorktreePs()
      const backslashSummary = summaries.worktrees.find(
        (worktree) => worktree.path === backslashWorktree.path
      )
      const slashSummary = summaries.worktrees.find(
        (worktree) => worktree.path === slashWorktree.path
      )

      expect(backslashSummary).toMatchObject({ hasHostSidebarActivity: true, status: 'working' })
      expect(backslashSummary?.agents).toHaveLength(100)
      expect(slashSummary?.agents).toEqual(includeSlashWorktree ? [] : undefined)
      const comparisonPlatform = repoPath.startsWith('C:') ? 'win32' : 'linux'
      const backslashKey = worktreePathComparison.worktreePathComparisonKey(
        backslashPath,
        comparisonPlatform
      )
      const slashKey = worktreePathComparison.worktreePathComparisonKey(
        slashPath,
        comparisonPlatform
      )
      expect(backslashKey === slashKey).toBe(!includeSlashWorktree)
    }
  )

  it('projects 100 distinct pair-aware paths without rescanning the worktree list', async () => {
    const remoteRepo = {
      id: 'repo-pair-aware-scale',
      path: '/remote',
      displayName: 'pair-aware-scale-vm',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-pair-aware-scale'
    }
    let pathReadCount = 0
    const remoteWorktrees = Array.from({ length: 100 }, (_, index) => {
      const path = `C:relative\\feature-${String(index).padStart(3, '0')}`
      return {
        get path() {
          pathReadCount += 1
          return path
        },
        head: `head-${index}`,
        branch: `refs/heads/feature-${index}`,
        isBare: false,
        isMainWorktree: false
      }
    })
    const runtimeStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === remoteRepo.id ? remoteRepo : undefined),
      getAllWorktreeMeta: () => ({}),
      getWorktreeMeta: () => undefined
    }
    registerSshGitProvider('ssh-pair-aware-scale', {
      listWorktrees: vi.fn().mockResolvedValue(remoteWorktrees)
    } as never)
    const now = Date.now()
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      getAgentStatusSnapshot: () =>
        remoteWorktrees.map((worktree, index) => ({
          paneKey: `pair-aware-tab:${String(index).padStart(8, '0')}-9999-4999-8999-999999999999`,
          worktreeId: `${remoteRepo.id}::${win32.resolve(worktree.path)}`,
          tabId: 'pair-aware-tab',
          state: 'working' as const,
          prompt: `pair-aware agent ${index}`,
          agentType: 'codex',
          connectionId: 'ssh-pair-aware-scale',
          receivedAt: now,
          stateStartedAt: now - 100
        }))
    })

    const summaries = await runtime.getWorktreePs()

    expect(summaries.worktrees).toHaveLength(100)
    expect(summaries.worktrees.every((worktree) => worktree.agents?.length === 1)).toBe(true)
    // Why: property reads make the scaling assertion mutation-sensitive without a flaky wall-clock threshold.
    expect(pathReadCount).toBeLessThan(2_000)
  })

  it('bounds 2000 distinct malformed path misses per mobile poll', async () => {
    const remoteRepo = {
      id: 'repo-malformed-scale',
      path: '/remote',
      displayName: 'malformed-scale-vm',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-malformed-scale'
    }
    let pathReadCount = 0
    const remoteWorktrees = Array.from({ length: 2_000 }, (_, index) => {
      const path = `/remote/worktree-${String(index).padStart(4, '0')}`
      return {
        get path() {
          pathReadCount += 1
          return path
        },
        head: `head-${index}`,
        branch: `refs/heads/worktree-${index}`,
        isBare: false,
        isMainWorktree: false
      }
    })
    const getRepo = vi.fn((id: string) => (id === remoteRepo.id ? remoteRepo : undefined))
    const runtimeStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo,
      getAllWorktreeMeta: () => ({}),
      getWorktreeMeta: () => undefined
    }
    registerSshGitProvider('ssh-malformed-scale', {
      listWorktrees: vi.fn().mockResolvedValue(remoteWorktrees)
    } as never)
    const now = Date.now()
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      getAgentStatusSnapshot: () =>
        Array.from({ length: 2_000 }, (_, index) => ({
          paneKey: `malformed-tab:${String(index).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
          worktreeId: `${remoteRepo.id}::relative/./missing-${String(index).padStart(4, '0')}\\leaf`,
          tabId: 'malformed-tab',
          state: 'working' as const,
          prompt: `missing agent ${index}`,
          agentType: 'codex',
          connectionId: 'ssh-malformed-scale',
          receivedAt: now,
          stateStartedAt: now - 100
        }))
    })

    const summaries = await runtime.getWorktreePs()

    expect(summaries).toMatchObject({ totalCount: 2_000, truncated: true })
    expect(summaries.worktrees.every((worktree) => worktree.agents?.length === 0)).toBe(true)
    expect(getRepo).toHaveBeenCalledTimes(remoteWorktrees.length)
    // Why: the prior fallback read every worktree path per distinct miss, exceeding the 3s worktree.ps poll interval at this scale.
    expect(pathReadCount).toBeLessThan(40_000)
  })

  it('caches repeated malformed path misses before normalizing them again', async () => {
    const remoteRepo = {
      id: 'repo-repeated-miss',
      path: '/remote',
      displayName: 'repeated-miss-vm',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-repeated-miss'
    }
    const remoteWorktree = {
      path: '/remote/existing',
      head: 'head-existing',
      branch: 'refs/heads/existing',
      isBare: false,
      isMainWorktree: false
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === remoteRepo.id ? remoteRepo : undefined),
      getAllWorktreeMeta: () => ({}),
      getWorktreeMeta: () => undefined
    }
    registerSshGitProvider('ssh-repeated-miss', {
      listWorktrees: vi.fn().mockResolvedValue([remoteWorktree])
    } as never)
    const now = Date.now()
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      getAgentStatusSnapshot: () =>
        Array.from({ length: 2_000 }, (_, index) => ({
          paneKey: `repeated-miss-tab:${String(index).padStart(8, '0')}-bbbb-4bbb-8bbb-bbbbbbbbbbbb`,
          worktreeId: `${remoteRepo.id}::relative/./missing\\leaf`,
          tabId: 'repeated-miss-tab',
          state: 'working' as const,
          prompt: `repeated missing agent ${index}`,
          agentType: 'codex',
          connectionId: 'ssh-repeated-miss',
          receivedAt: now,
          stateStartedAt: now - 100
        }))
    })
    const cwdSpy = vi.spyOn(process, 'cwd')

    try {
      const summaries = await runtime.getWorktreePs()

      expect(summaries.worktrees[0]?.agents).toEqual([])
      // Why: resolving a relative comparison key consults cwd; a raw miss must do that once per poll, not per agent row.
      expect(cwdSpy.mock.calls.length).toBeLessThan(50)
    } finally {
      cwdSpy.mockRestore()
    }
  })

  it('keeps no-PTY agent worktrees in the truncated mobile summary', async () => {
    const remoteRepo = {
      id: 'repo-truncated-ssh',
      path: '/remote',
      displayName: 'truncated-vm',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-truncated'
    }
    const targetPath = '/remote/zzz-live-agent'
    const remoteWorktrees = [
      ...Array.from({ length: 200 }, (_, index) => ({
        path: `/remote/inactive-${String(index).padStart(3, '0')}`,
        head: `head-${index}`,
        branch: `refs/heads/inactive-${index}`,
        isBare: false,
        isMainWorktree: false
      })),
      {
        path: targetPath,
        head: 'live-agent',
        branch: 'refs/heads/live-agent',
        isBare: false,
        isMainWorktree: false
      }
    ]
    const runtimeStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === remoteRepo.id ? remoteRepo : undefined),
      getAllWorktreeMeta: () => ({}),
      getWorktreeMeta: () => undefined
    }
    registerSshGitProvider('ssh-truncated', {
      listWorktrees: vi.fn().mockResolvedValue(remoteWorktrees)
    } as never)
    const now = Date.now()
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey: 'truncated-tab:77777777-7777-4777-8777-777777777777',
          worktreeId: `${remoteRepo.id}::${targetPath}/`,
          tabId: 'truncated-tab',
          state: 'working',
          prompt: 'live beyond the default limit',
          agentType: 'codex',
          connectionId: 'ssh-truncated',
          receivedAt: now,
          stateStartedAt: now - 100
        }
      ]
    })

    const summaries = await runtime.getWorktreePs()
    const target = summaries.worktrees.find((worktree) => worktree.path === targetPath)

    expect(summaries).toMatchObject({ totalCount: 201, truncated: true })
    expect(summaries.worktrees).toHaveLength(200)
    expect(target).toMatchObject({ hasHostSidebarActivity: true, status: 'working' })
    expect(target?.agents).toHaveLength(1)
  })
})
