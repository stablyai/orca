import { describe, expect, it, vi } from 'vitest'
import {
  OrcaRuntimeService,
  getDefaultWorkspaceSession,
  join,
  makePaneKey,
  mkdtemp,
  tmpdir
} from '../orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  TEST_FOLDER_PROJECT_GROUP_ID,
  TEST_FOLDER_WORKSPACE_KEY,
  TEST_REPO_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  createFolderWorkspaceRuntimeStore,
  expectStablePaneKeyEnv,
  makeFolderProjectGroup,
  makeFolderWorkspace,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal,
  store
} from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('returns the exact pre-minted leaf for concurrent renderer-backed splits', async () => {
    const tabId = 'tab-concurrent-splits'
    const sourceLeafId = '11111111-1111-4111-8111-111111111111'
    const splitTerminal = vi.fn()
    const runtime = new OrcaRuntimeService(store)
    runtime.setNotifier({ splitTerminal } as never)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: 'shell',
          activeLeafId: sourceLeafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId: sourceLeafId,
          paneRuntimeId: 1,
          ptyId: 'pty-source',
          paneTitle: null
        }
      ]
    })
    const sourceHandle = runtime.getTerminalHandleForPaneKey(makePaneKey(tabId, sourceLeafId))
    expect(sourceHandle).not.toBeNull()

    const horizontal = runtime.splitTerminal(sourceHandle!, { direction: 'horizontal' })
    const vertical = runtime.splitTerminal(sourceHandle!, { direction: 'vertical' })
    await vi.waitFor(() => expect(splitTerminal).toHaveBeenCalledTimes(2))
    const horizontalLeafId = splitTerminal.mock.calls.find(
      (call) => call[2]?.direction === 'horizontal'
    )?.[2]?.newLeafId
    const verticalLeafId = splitTerminal.mock.calls.find(
      (call) => call[2]?.direction === 'vertical'
    )?.[2]?.newLeafId
    expect(horizontalLeafId).toEqual(expect.any(String))
    expect(verticalLeafId).toEqual(expect.any(String))
    expect(horizontalLeafId).not.toBe(verticalLeafId)

    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: 'shell',
          activeLeafId: verticalLeafId,
          layout: null
        }
      ],
      // Reverse publication order so a first-new-leaf heuristic would swap the receipts.
      leaves: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId: verticalLeafId!,
          paneRuntimeId: 3,
          ptyId: 'pty-vertical',
          paneTitle: null
        },
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId: horizontalLeafId!,
          paneRuntimeId: 2,
          ptyId: 'pty-horizontal',
          paneTitle: null
        },
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId: sourceLeafId,
          paneRuntimeId: 1,
          ptyId: 'pty-source',
          paneTitle: null
        }
      ]
    })

    await expect(horizontal).resolves.toMatchObject({ leafId: horizontalLeafId })
    await expect(vertical).resolves.toMatchObject({ leafId: verticalLeafId })
  })

  it('splits visible pty-backed terminal sessions through the parent renderer tab', async () => {
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-source' })
      .mockResolvedValueOnce({ id: 'pty-split' })
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-bg' })
    const splitTerminal = vi.fn()
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession,
      splitTerminal,
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      launchAgent: 'codex'
    })
    const sourceEnv =
      (spawn.mock.calls[0]?.[0] as { env?: Record<string, string> } | undefined)?.env ?? {}
    const sourceLeafId = sourceEnv.ORCA_PANE_KEY.slice(`${sourceEnv.ORCA_TAB_ID}:`.length)

    const split = await runtime.splitTerminal(handle, { direction: 'vertical' })
    expect(split).toMatchObject({
      handle: expect.stringMatching(/^term_/),
      tabId: sourceEnv.ORCA_TAB_ID,
      paneRuntimeId: -1
    })

    const splitEnv =
      (spawn.mock.calls[1]?.[0] as { env?: Record<string, string> } | undefined)?.env ?? {}
    const splitLeafId = splitEnv.ORCA_PANE_KEY.slice(`${sourceEnv.ORCA_TAB_ID}:`.length)
    expect(split.leafId).toBe(splitLeafId)
    expect(splitTerminal).not.toHaveBeenCalled()
    expect(splitEnv.ORCA_TAB_ID).toBe(sourceEnv.ORCA_TAB_ID)
    expect(splitEnv.ORCA_WORKTREE_ID).toBe(TEST_WORKTREE_ID)
    expect(revealTerminalSession).toHaveBeenLastCalledWith(TEST_WORKTREE_ID, {
      ptyId: 'pty-split',
      title: null,
      activate: true,
      tabId: sourceEnv.ORCA_TAB_ID,
      leafId: splitLeafId,
      splitFromLeafId: sourceLeafId,
      splitDirection: 'vertical'
    })

    // Why: client renders the tab from one sibling's parentLayout, so all siblings must carry the direction or Split Right flips down.
    const publishedTabs = runtime['mobileSessionTabsByWorktree'].get(TEST_WORKTREE_ID)!.tabs
    const siblingSurfaces = publishedTabs.filter(
      (tab): tab is Extract<typeof tab, { type: 'terminal' }> =>
        tab.type === 'terminal' && tab.parentTabId === sourceEnv.ORCA_TAB_ID
    )
    expect(siblingSurfaces.length).toBe(2)
    for (const surface of siblingSurfaces) {
      expect(surface.parentLayout?.root).toMatchObject({ type: 'split', direction: 'vertical' })
    }
  })

  it('keeps a persisted split when mounted renderer adoption rejects', async () => {
    const tabId = 'persisted-mounted-tab'
    const ptyId = 'persisted-mounted-pty'
    const splitPtyId = 'persisted-mounted-split-pty'
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: tabId,
              ptyId,
              worktreeId: TEST_WORKTREE_ID,
              title: 'Persisted terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        terminalLayoutsByTabId: {
          [tabId]: makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: ptyId })
        }
      })
    )
    const revealTerminalSession = vi.fn().mockRejectedValue(new Error('renderer rejected'))
    const kill = vi.fn(() => true)
    let resolveSpawn!: (result: { id: string }) => void
    const spawn = vi.fn(
      (_args: unknown) =>
        new Promise<{ id: string }>((resolve) => {
          resolveSpawn = resolve
        })
    )
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({ revealTerminalSession } as never)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    runtime.registerPty(ptyId, TEST_WORKTREE_ID, null, {
      tabId,
      leafId: HEADLESS_LEAF_ID,
      incarnationId: 'live-source-incarnation'
    })
    const internals = runtime as unknown as {
      issuePtyHandle: (pty: unknown) => string
      ptysById: Map<string, unknown>
    }
    const handle = internals.issuePtyHandle(internals.ptysById.get(ptyId))
    const split = runtime.splitTerminal(handle, { direction: 'horizontal' })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    const splitSpawn = spawn.mock.calls[0]?.[0] as
      | { expectedSourceBinding?: { incarnationId?: string } }
      | undefined
    // Why: persistence never recorded an incarnation for this pane, so sending the live-only id
    // would make the store's fence reject every split from a restored session.
    expect(splitSpawn?.expectedSourceBinding).not.toHaveProperty('incarnationId')

    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Persisted terminal',
          activeLeafId: HEADLESS_LEAF_ID,
          layout: { type: 'leaf', leafId: HEADLESS_LEAF_ID }
        }
      ],
      leaves: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId: HEADLESS_LEAF_ID,
          paneRuntimeId: 1,
          ptyId
        }
      ]
    })
    resolveSpawn({ id: splitPtyId })

    await expect(split).resolves.toMatchObject({
      tabId,
      handle: expect.stringMatching(/^term_/)
    })

    expect(revealTerminalSession).toHaveBeenCalledOnce()
    expect(kill).not.toHaveBeenCalled()
    expect(getSession().terminalLayoutsByTabId[tabId]?.root).toMatchObject({
      type: 'split',
      direction: 'horizontal'
    })
  })

  it('rejects a persisted split closed during spawn without recreating its tab', async () => {
    const tabId = 'closing-persisted-tab'
    const ptyId = 'closing-persisted-pty'
    const { runtimeStore, getSession, setSession } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: tabId,
              ptyId,
              worktreeId: TEST_WORKTREE_ID,
              title: 'Closing terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        terminalLayoutsByTabId: {
          [tabId]: makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: ptyId })
        }
      })
    )
    let resolveSpawn!: (result: { id: string }) => void
    const spawn = vi.fn(
      (_args: unknown) =>
        new Promise<{ id: string }>((resolve) => {
          resolveSpawn = resolve
        })
    )
    const kill = vi.fn(() => false)
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    runtime.registerPty(ptyId, TEST_WORKTREE_ID, null, {
      tabId,
      leafId: HEADLESS_LEAF_ID
    })
    const internals = runtime as unknown as {
      issuePtyHandle: (pty: unknown) => string
      ptysById: Map<string, unknown>
    }
    const handle = internals.issuePtyHandle(internals.ptysById.get(ptyId))
    const split = runtime.splitTerminal(handle, { direction: 'vertical' })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())

    setSession(getDefaultWorkspaceSession())
    runtimeStore.persistPtyBinding.mockReturnValue(false)
    resolveSpawn({ id: 'rejected-split-pty' })

    await expect(split).rejects.toThrow('terminal_split_source_not_found')
    expect(spawn.mock.calls[0]?.[0]).toMatchObject({
      persistHostSessionBinding: true,
      expectedSourceBinding: {
        worktreeId: TEST_WORKTREE_ID,
        tabId,
        leafId: HEADLESS_LEAF_ID,
        ptyId
      }
    })
    expect(kill).toHaveBeenCalledWith('rejected-split-pty')
    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toBeUndefined()
    expect(getSession().terminalLayoutsByTabId[tabId]).toBeUndefined()
  })

  it('rejects a projected split retired during spawn before publishing the new pane', async () => {
    let resolveSplitSpawn!: (result: { id: string }) => void
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'projected-source-pty' })
      .mockImplementationOnce(
        () =>
          new Promise<{ id: string }>((resolve) => {
            resolveSplitSpawn = resolve
          })
      )
    const kill = vi.fn(() => true)
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    const split = runtime.splitTerminal(handle, { direction: 'vertical' })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))

    runtime['mobileSessionTabsByWorktree'].delete(TEST_WORKTREE_ID)
    resolveSplitSpawn({ id: 'retired-projected-split-pty' })

    await expect(split).rejects.toThrow('terminal_split_source_not_found')
    expect(kill).toHaveBeenCalledWith('retired-projected-split-pty')
    expect(runtime['mobileSessionTabsByWorktree'].has(TEST_WORKTREE_ID)).toBe(false)
  })

  it('splits folder workspace pty-backed terminal sessions with folder cwd and env', async () => {
    const folderPath = await mkdtemp(join(tmpdir(), 'orca-runtime-folder-split-'))
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-folder-source' })
      .mockResolvedValueOnce({ id: 'pty-folder-split' })
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-folder' })
    const folderWorkspace = makeFolderWorkspace({ folderPath })
    const projectGroup = makeFolderProjectGroup({ parentPath: folderPath })
    const runtime = new OrcaRuntimeService(
      createFolderWorkspaceRuntimeStore(folderWorkspace, projectGroup) as never
    )
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const { handle } = await runtime.createTerminal(TEST_FOLDER_WORKSPACE_KEY)
    const sourceCall = spawn.mock.calls[0]?.[0] as
      | { cwd?: string; env?: Record<string, string>; worktreeId?: string }
      | undefined
    const sourceEnv = sourceCall?.env ?? {}
    const sourceLeafId = sourceEnv.ORCA_PANE_KEY.slice(`${sourceEnv.ORCA_TAB_ID}:`.length)

    await expect(runtime.splitTerminal(handle, { direction: 'vertical' })).resolves.toMatchObject({
      handle: expect.stringMatching(/^term_/),
      tabId: sourceEnv.ORCA_TAB_ID,
      paneRuntimeId: -1
    })

    const splitCall = spawn.mock.calls[1]?.[0] as
      | { cwd?: string; env?: Record<string, string>; worktreeId?: string }
      | undefined
    const splitEnv = splitCall?.env ?? {}
    const splitLeafId = splitEnv.ORCA_PANE_KEY.slice(`${sourceEnv.ORCA_TAB_ID}:`.length)
    expect(sourceCall).toMatchObject({
      cwd: folderPath,
      worktreeId: TEST_FOLDER_WORKSPACE_KEY
    })
    expect(splitCall).toMatchObject({
      cwd: folderPath,
      worktreeId: TEST_FOLDER_WORKSPACE_KEY
    })
    expectStablePaneKeyEnv(splitEnv)
    expect(splitEnv.ORCA_TAB_ID).toBe(sourceEnv.ORCA_TAB_ID)
    expect(splitEnv.ORCA_WORKSPACE_ID).toBe(TEST_FOLDER_WORKSPACE_KEY)
    expect(splitEnv.ORCA_PROJECT_GROUP_ID).toBe(TEST_FOLDER_PROJECT_GROUP_ID)
    expect(splitEnv.ORCA_WORKSPACE_ROOT).toBe(folderPath)
    expect(splitEnv.ORCA_WORKTREE_ID).toBe(TEST_FOLDER_WORKSPACE_KEY)
    expect(revealTerminalSession).toHaveBeenLastCalledWith(TEST_FOLDER_WORKSPACE_KEY, {
      ptyId: 'pty-folder-split',
      title: null,
      activate: true,
      tabId: sourceEnv.ORCA_TAB_ID,
      leafId: splitLeafId,
      splitFromLeafId: sourceLeafId,
      splitDirection: 'vertical'
    })
  })

  it('atomically admits persisted SSH splits in the SSH host partition', async () => {
    const tabId = 'ssh-split-tab'
    const sourcePtyId = 'ssh:ssh-1@@source-pty'
    const splitPtyId = 'ssh:ssh-1@@split-pty'
    const remoteRepo = { ...store.getRepo(TEST_REPO_ID)!, connectionId: 'ssh-1' }
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: tabId,
              ptyId: sourcePtyId,
              worktreeId: TEST_WORKTREE_ID,
              title: 'SSH terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        terminalLayoutsByTabId: {
          [tabId]: makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: sourcePtyId })
        }
      }),
      'ssh:ssh-1'
    )
    const spawn = vi.fn().mockResolvedValue({ id: splitPtyId })
    const runtime = new OrcaRuntimeService({
      ...runtimeStore,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === TEST_REPO_ID ? remoteRepo : undefined)
    } as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    runtime.registerPty(sourcePtyId, TEST_WORKTREE_ID, 'ssh-1', {
      tabId,
      leafId: HEADLESS_LEAF_ID
    })
    const internals = runtime as unknown as {
      issuePtyHandle: (pty: unknown) => string
      ptysById: Map<string, unknown>
    }
    const handle = internals.issuePtyHandle(internals.ptysById.get(sourcePtyId))

    await expect(runtime.splitTerminal(handle, { direction: 'vertical' })).resolves.toMatchObject({
      tabId,
      handle: expect.stringMatching(/^term_/)
    })

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: 'ssh-1',
        worktreeId: TEST_WORKTREE_ID,
        persistHostSessionBinding: true,
        expectedSourceBinding: expect.objectContaining({
          worktreeId: TEST_WORKTREE_ID,
          tabId,
          leafId: HEADLESS_LEAF_ID,
          ptyId: sourcePtyId
        })
      })
    )
    expect(getSession().terminalLayoutsByTabId[tabId]?.root).toMatchObject({
      type: 'split',
      direction: 'vertical'
    })
  })

  it('returns an actionable discoverability warning when default adoption fails after spawn', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const revealTerminalSession = vi.fn().mockRejectedValue(new Error('Renderer timed out'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })

    try {
      const created = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
      expect(created).toMatchObject({
        worktreeId: TEST_WORKTREE_ID,
        surface: 'background',
        handle: expect.stringMatching(/^term_/)
      })
      expect(created.warning).toContain('Renderer timed out')
      expect(created.warning).toContain('could not make it discoverable')
      expect(created.warning).toContain(`orca terminal focus --terminal ${created.handle}`)
      const spawnCall = spawn.mock.calls[0]?.[0] as { env?: Record<string, string> } | undefined
      const spawnedEnv = spawnCall?.env ?? {}
      expectStablePaneKeyEnv(spawnedEnv)
      const spawnedLeafId = spawnedEnv.ORCA_PANE_KEY.slice(`${spawnedEnv.ORCA_TAB_ID}:`.length)
      expect(revealTerminalSession).toHaveBeenCalledWith(TEST_WORKTREE_ID, {
        ptyId: 'pty-bg',
        title: null,
        activate: false,
        tabId: spawnedEnv.ORCA_TAB_ID,
        leafId: spawnedLeafId
      })
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('[terminal-create] failed to create inactive tab for pty-bg:'),
        expect.any(Error)
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('returns an actionable warning when default discoverability has no renderer notifier', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const created = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)

    expect(created).toMatchObject({
      worktreeId: TEST_WORKTREE_ID,
      surface: 'background',
      handle: expect.stringMatching(/^term_/)
    })
    expect(created.warning).toContain('could not make it discoverable')
    expect(created.warning).toContain(`orca terminal focus --terminal ${created.handle}`)
  })

  it('does not warn when background presentation has no renderer notifier', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const created = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      presentation: 'background'
    })

    expect(created).toMatchObject({
      worktreeId: TEST_WORKTREE_ID,
      surface: 'background',
      handle: expect.stringMatching(/^term_/)
    })
    expect(created.warning).toBeUndefined()
  })
})
