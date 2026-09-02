import { describe, expect, it, vi } from 'vitest'
import {
  MOCK_GIT_WORKTREES,
  OrcaRuntimeService,
  basename,
  join,
  listWorktrees,
  tmpdir
} from '../orca-runtime-test-mocks.spec'
import type { WorktreeLineage, WorktreeMeta } from '../orca-runtime-test-mocks.spec'
import {
  TEST_REPO_ID,
  TEST_REPO_PATH,
  TEST_WORKTREE_ID,
  deferred,
  makeWorktreeMeta,
  store,
  withPlatform
} from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('tui-idle times out when PTY data has no agent OSC title transitions', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)

      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId: 'tab-1',
            worktreeId: 'repo-1::/tmp/worktree-a',
            title: 'Terminal 1',
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
      runtime.onPtyData('pty-1', 'running migration step 4/9\n', 123)

      const [terminal] = (await runtime.listTerminals()).terminals
      const waitPromise = runtime.waitForTerminal(terminal.handle, {
        condition: 'tui-idle',
        timeoutMs: 1_000
      })
      const timeoutAssertion = expect(waitPromise).rejects.toThrow('timeout')

      await vi.advanceTimersByTimeAsync(12_000)

      await timeoutAssertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('tui-idle resolves on agent working→idle OSC title transition', async () => {
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

    // Simulate agent starting work (braille spinner = working)
    runtime.onPtyData('pty-1', '\x1b]0;\u280b Working on task\x07output\n', 100)

    const [terminal] = (await runtime.listTerminals()).terminals
    const waitPromise = runtime.waitForTerminal(terminal.handle, {
      condition: 'tui-idle',
      timeoutMs: 5_000
    })

    // Simulate agent finishing (✳ = Claude Code idle)
    runtime.onPtyData('pty-1', '\x1b]0;\u2733 Task complete\x07done\n', 200)

    const result = await waitPromise
    expect(result.condition).toBe('tui-idle')
    expect(result.satisfied).toBe(true)
  })

  it('builds a compact worktree summary from persisted and live runtime state', async () => {
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
    runtime.onPtyData('pty-1', 'build green\n', 321)

    const summaries = await runtime.getWorktreePs()
    expect(summaries).toEqual({
      worktrees: [
        {
          workspaceKind: 'git',
          worktreeId: 'repo-1::/tmp/worktree-a',
          repoId: 'repo-1',
          hostId: 'local',
          terminalPlatform: process.platform,
          repo: 'repo',
          path: '/tmp/worktree-a',
          branch: 'feature/foo',
          isArchived: false,
          isMainWorktree: false,
          hasHostSidebarActivity: true,
          parentWorktreeId: null,
          childWorktreeIds: [],
          displayName: 'foo',
          workspaceStatus: 'in-progress',
          sortOrder: 0,
          linkedIssue: 123,
          linkedPR: null,
          linkedLinearIssue: null,
          linkedGitLabMR: null,
          linkedGitLabIssue: null,
          comment: '',
          isPinned: false,
          isActive: false,
          status: 'active',
          unread: false,
          liveTerminalCount: 1,
          hasAttachedPty: true,
          lastActivityAt: 0,
          lastOutputAt: 321,
          preview: 'build green',
          agents: []
        }
      ],
      totalCount: 1,
      truncated: false
    })
  })

  it('reads the linked-PR state from the renderer repoId-keyed GitHub cache', async () => {
    // Regression: renderer keys the PR cache by repoId::branch; reading by path::branch missed every entry (muted mobile badge).
    const runtimeStore = {
      ...store,
      getGitHubCache: () => ({
        pr: {
          [`${TEST_REPO_ID}::feature/foo`]: {
            data: { number: 42, state: 'merged' },
            fetchedAt: 1
          }
        },
        issue: {}
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    const { worktrees } = await runtime.getWorktreePs()
    const summary = worktrees.find((w) => w.worktreeId === TEST_WORKTREE_ID)
    expect(summary?.linkedPR).toEqual({ number: 42, state: 'merged' })
  })

  it('carries persisted worktree host ownership in mobile summaries', async () => {
    const metaById = {
      [TEST_WORKTREE_ID]: {
        ...store.getAllWorktreeMeta()[TEST_WORKTREE_ID],
        hostId: 'runtime:owner-runtime' as const
      }
    }
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId]
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    const { worktrees } = await runtime.getWorktreePs()

    expect(worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)).toMatchObject({
      repoId: TEST_REPO_ID,
      hostId: 'runtime:owner-runtime'
    })
  })

  it('emits only instance- and boundary-validated lineage parents in mobile summaries', async () => {
    // Regression: shipped mobile clients trust parentWorktreeId blindly, so worktree.ps must not emit stale same-path lineage.
    const parentPath = join(tmpdir(), 'worktree-parent')
    const validChildPath = join(tmpdir(), 'worktree-child-valid')
    const staleChildPath = join(tmpdir(), 'worktree-child-stale')
    const crossHostChildPath = join(tmpdir(), 'worktree-child-cross-host')
    const parentId = `${TEST_REPO_ID}::${parentPath}`
    const validChildId = `${TEST_REPO_ID}::${validChildPath}`
    const staleChildId = `${TEST_REPO_ID}::${staleChildPath}`
    const crossHostChildId = `${TEST_REPO_ID}::${crossHostChildPath}`
    const metaById: Record<string, WorktreeMeta> = {
      [parentId]: makeWorktreeMeta({
        instanceId: 'parent-instance',
        hostId: 'local',
        projectId: 'project-a'
      }),
      [validChildId]: makeWorktreeMeta({
        instanceId: 'child-instance',
        hostId: 'local',
        projectId: 'project-a'
      }),
      // The stale child path was reused by a replacement checkout.
      [staleChildId]: makeWorktreeMeta({ instanceId: 'replacement-instance' }),
      [crossHostChildId]: makeWorktreeMeta({
        instanceId: 'cross-host-child-instance',
        hostId: 'runtime:other-host',
        projectId: 'project-a'
      })
    }
    const makeLineage = (childId: string, worktreeInstanceId: string): WorktreeLineage => ({
      worktreeId: childId,
      worktreeInstanceId,
      parentWorktreeId: parentId,
      parentWorktreeInstanceId: 'parent-instance',
      origin: 'manual',
      capture: { source: 'manual-action', confidence: 'explicit' },
      createdAt: 1
    })
    const lineageById: Record<string, WorktreeLineage> = {
      [validChildId]: makeLineage(validChildId, 'child-instance'),
      [staleChildId]: makeLineage(staleChildId, 'old-child-instance'),
      [crossHostChildId]: makeLineage(crossHostChildId, 'cross-host-child-instance')
    }
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      },
      getAllWorktreeLineage: () => lineageById,
      getWorktreeLineage: (worktreeId: string) => lineageById[worktreeId]
    }
    vi.mocked(listWorktrees).mockResolvedValue(
      [parentPath, validChildPath, staleChildPath, crossHostChildPath].map((path) => ({
        path,
        head: 'abc',
        branch: `feature/${basename(path)}`,
        isBare: false,
        isMainWorktree: false
      }))
    )
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    const { worktrees } = await runtime.getWorktreePs()

    expect(worktrees.find((worktree) => worktree.worktreeId === validChildId)).toMatchObject({
      parentWorktreeId: parentId,
      worktreeInstanceId: 'child-instance',
      lineageWorktreeInstanceId: 'child-instance',
      parentWorktreeInstanceId: 'parent-instance'
    })
    const staleSummary = worktrees.find((worktree) => worktree.worktreeId === staleChildId)
    expect(staleSummary).toMatchObject({
      parentWorktreeId: null,
      worktreeInstanceId: 'replacement-instance'
    })
    expect(staleSummary?.lineageWorktreeInstanceId).toBeUndefined()
    expect(staleSummary?.parentWorktreeInstanceId).toBeUndefined()
    const crossHostSummary = worktrees.find((worktree) => worktree.worktreeId === crossHostChildId)
    expect(crossHostSummary).toMatchObject({
      parentWorktreeId: null,
      worktreeInstanceId: 'cross-host-child-instance'
    })
    expect(crossHostSummary?.lineageWorktreeInstanceId).toBeUndefined()
    expect(crossHostSummary?.parentWorktreeInstanceId).toBeUndefined()
    expect(worktrees.find((worktree) => worktree.worktreeId === parentId)).toMatchObject({
      childWorktreeIds: [validChildId]
    })
  })

  it('resolves WSL platforms only for repos represented in mobile summaries', async () => {
    await withPlatform('win32', async () => {
      const primaryRepo = store.getRepos()[0]!
      let repos = [
        primaryRepo,
        ...Array.from({ length: 100 }, (_, index) => ({
          ...primaryRepo,
          id: `repo-represented-${index}`,
          path: `C:\\repo-represented-${index}`,
          displayName: `repo-represented-${index}`
        }))
      ]
      const getProjects = vi.fn(() =>
        repos.slice(0, 101).map((repo, index) => ({
          id: `project-${index}`,
          displayName: repo.displayName,
          badgeColor: 'blue',
          sourceRepoIds: [repo.id],
          localWindowsRuntimePreference:
            index === 0
              ? ({ kind: 'wsl' as const, distro: 'Ubuntu' } as const)
              : ({ kind: 'windows-host' as const } as const),
          createdAt: 0,
          updatedAt: 0
        }))
      )
      const getSettings = vi.fn(() => ({
        ...store.getSettings(),
        localWindowsRuntimeDefault: { kind: 'windows-host' as const }
      }))
      const runtime = new OrcaRuntimeService({
        ...store,
        getRepos: () => repos,
        getProjects,
        getSettings
      } as never)

      const { worktrees } = await runtime.getWorktreePs()

      expect(worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)).toMatchObject({
        repoId: TEST_REPO_ID,
        terminalPlatform: 'linux'
      })
      expect(getProjects).toHaveBeenCalledTimes(1)
      expect(getSettings).toHaveBeenCalledTimes(2)
      getProjects.mockClear()
      getSettings.mockClear()
      repos = [
        ...repos,
        ...Array.from({ length: 2_000 }, (_, index) => ({
          ...repos[0]!,
          id: `repo-unresolved-${index}`,
          path: `C:\\repo-unresolved-${index}`,
          displayName: `repo-unresolved-${index}`
        }))
      ]

      await runtime.getWorktreePs()

      // Why: the cache already owns the batch-resolved platforms; newly persisted repos must not trigger another scan.
      expect(getProjects).not.toHaveBeenCalled()
      expect(getSettings).toHaveBeenCalledTimes(1)
    })
  })

  it('keeps each worktree poll paired with its platform generation', async () => {
    await withPlatform('win32', async () => {
      let runtimePreference: { kind: 'wsl'; distro: string } | { kind: 'windows-host' } = {
        kind: 'wsl',
        distro: 'Ubuntu'
      }
      const runtimeStore = {
        ...store,
        getProjects: () => [
          {
            id: 'project-generation',
            displayName: 'generation',
            badgeColor: 'blue',
            sourceRepoIds: [TEST_REPO_ID],
            localWindowsRuntimePreference: runtimePreference,
            createdAt: 0,
            updatedAt: 0
          }
        ],
        getSettings: () => ({
          ...store.getSettings(),
          localWindowsRuntimeDefault: { kind: 'windows-host' as const }
        })
      }
      const staleScan = deferred<typeof MOCK_GIT_WORKTREES>()
      vi.mocked(listWorktrees)
        .mockImplementationOnce(() => staleScan.promise)
        .mockResolvedValueOnce(MOCK_GIT_WORKTREES)
      const runtime = new OrcaRuntimeService(runtimeStore as never)

      const stalePoll = runtime.getWorktreePs()
      runtimePreference = { kind: 'windows-host' }
      runtime.notifyBranchRenamed(TEST_REPO_ID)
      const freshPoll = await runtime.getWorktreePs()
      staleScan.resolve(MOCK_GIT_WORKTREES)
      const staleResult = await stalePoll

      // Why: invalidation can let a newer scan finish first; each result keeps the platform map from its own generation.
      expect(staleResult.worktrees[0]).toMatchObject({ terminalPlatform: 'linux' })
      expect(freshPoll.worktrees[0]).toMatchObject({ terminalPlatform: 'win32' })
    })
  })

  it('omits worktrees hidden by the host visibility policy from mobile summaries', async () => {
    const hiddenExternalRepo = {
      ...store.getRepos()[0],
      externalWorktreeVisibility: 'hide' as const,
      externalWorktreeVisibilityLegacy: false
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [hiddenExternalRepo],
      getRepo: () => hiddenExternalRepo
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await expect(runtime.getWorktreePs()).resolves.toMatchObject({
      worktrees: [],
      totalCount: 0,
      truncated: false
    })
  })

  it('applies linked-checkout source visibility to mobile summaries', async () => {
    const linkedPath = '/tmp/linked'
    const scratchPath = `${linkedPath}/.claude/worktrees/review`
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: TEST_REPO_PATH,
        head: 'main',
        branch: 'main',
        isBare: false,
        isMainWorktree: true
      },
      {
        path: linkedPath,
        head: 'linked',
        branch: 'feature/linked',
        isBare: false,
        isMainWorktree: false
      },
      {
        path: scratchPath,
        head: 'scratch',
        branch: 'feature/review',
        isBare: false,
        isMainWorktree: false
      }
    ])
    const makeRuntime = (externalWorktreeVisibility: 'hide' | 'show', claude: 'hide' | 'show') => {
      const repo = {
        ...store.getRepos()[0],
        externalWorktreeVisibility,
        externalWorktreeVisibilityLegacy: false,
        worktreeVisibilitySourcePreferences: { builtIn: { claude, gsd: 'hide' as const } }
      }
      return new OrcaRuntimeService({
        ...store,
        getRepos: () => [repo],
        getRepo: () => repo
      } as never)
    }

    const hiddenSource = await makeRuntime('show', 'hide').getWorktreePs()
    const shownSource = await makeRuntime('hide', 'show').getWorktreePs()

    expect(hiddenSource.worktrees.map((worktree) => worktree.path)).not.toContain(scratchPath)
    expect(shownSource.worktrees.map((worktree) => worktree.path)).toContain(scratchPath)
  })
})
