import { describe, expect, it, vi } from 'vitest'
import {
  MOCK_GIT_WORKTREES,
  OrcaRuntimeService,
  electronMocks,
  getRuntimeBrowserPageRegistry,
  ipcMain,
  listWorktrees
} from '../orca-runtime-test-mocks.spec'
import type { RuntimeMobileSessionTabsResult } from '../orca-runtime-test-mocks.spec'
import {
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  UUID_RE,
  deferred,
  store
} from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('keeps client selection when a renderer session-tab close cannot commit', async () => {
    const closeSessionTab = vi.fn().mockRejectedValue(new Error('session_tab_close_canceled'))
    const runtime = new OrcaRuntimeService(store)
    const forgetTabs = vi.spyOn(runtime['clientSessionTabSelections'], 'forgetTabs')
    runtime.setNotifier({ closeSessionTab } as never)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-1',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: 'browser-unified-1',
          activeTabType: 'browser',
          tabs: [
            {
              type: 'browser',
              id: 'browser-unified-1',
              title: 'Browser',
              browserWorkspaceId: 'browser-workspace-1',
              browserPageId: 'browser-page-1',
              url: 'https://example.com/',
              loading: false,
              canGoBack: false,
              canGoForward: false,
              isActive: true
            }
          ]
        }
      ]
    })

    await expect(
      runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'browser-workspace-1')
    ).rejects.toThrow('session_tab_close_canceled')

    expect(forgetTabs).not.toHaveBeenCalled()

    runtime.setNotifier(null)
    await expect(
      runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'browser-workspace-1')
    ).rejects.toThrow('runtime_unavailable')
    expect(forgetTabs).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'retires client-hosted session tabs through their selected engine when offscreen=%s',
    async (withOffscreen) => {
      const runtime = new OrcaRuntimeService(store)
      const pages = getRuntimeBrowserPageRegistry(runtime)
      const placement = {
        kind: 'client' as const,
        browserHostClientId: 'host-a',
        browserHostGeneration: 3,
        pageHostGeneration: 9
      }
      pages.publishClientPage({
        browserPageId: 'client-page-1',
        workspaceId: TEST_WORKTREE_ID,
        browserProfileId: 'default',
        executionHostKey: 'native:runtime-a:1',
        placement,
        url: 'https://remote.internal/',
        loading: false,
        active: true
      })
      const closeOffscreenTab = vi.fn()
      if (withOffscreen) {
        runtime.setOffscreenBrowserBackend({
          createTab: vi.fn(),
          closeTab: closeOffscreenTab
        })
      }
      runtime.syncWindowGraph(0, {
        tabs: [],
        leaves: [],
        mobileSessionTabs: [
          {
            worktree: TEST_WORKTREE_ID,
            publicationEpoch: 'headless:test',
            snapshotVersion: 1,
            activeGroupId: 'group-1',
            activeTabId: 'client-page-1',
            activeTabType: 'browser',
            tabs: [
              {
                type: 'browser',
                id: 'client-page-1',
                title: 'Client page',
                browserWorkspaceId: 'client-page-1',
                browserPageId: 'client-page-1',
                browserProfileId: 'default',
                executionHostKey: 'native:runtime-a:1',
                placement,
                url: 'https://remote.internal/',
                loading: false,
                canGoBack: false,
                canGoForward: false,
                isActive: true
              }
            ]
          }
        ]
      })
      const closeClientPage = vi
        .spyOn(runtime, 'browserTabClose')
        .mockImplementation(async ({ page }) => {
          expect(pages.retirePage(page!, placement)).toBe(true)
          return { closed: true }
        })

      expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([
        expect.objectContaining({ browserPageId: 'client-page-1', placement })
      ])
      await expect(
        runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'client-page-1')
      ).resolves.toEqual({ closed: true })

      expect(closeClientPage).toHaveBeenCalledWith({
        worktree: `id:${TEST_WORKTREE_ID}`,
        page: 'client-page-1'
      })
      expect(closeOffscreenTab).not.toHaveBeenCalled()
      expect(pages.getPage('client-page-1')).toBeUndefined()
      expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([])
    }
  )

  it('closes an offscreen browser without overwriting a concurrent session update', async () => {
    const closeProof = deferred<void>()
    const closeOffscreenTab = vi.fn(() => closeProof.promise)
    const closeSessionTab = vi.fn()
    const runtime = new OrcaRuntimeService(store)
    runtime.setOffscreenBrowserBackend({
      createTab: vi.fn(),
      closeTab: closeOffscreenTab
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      closeSessionTab,
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    const browserTab = {
      type: 'browser' as const,
      id: 'offscreen-page-1',
      title: 'Offscreen page',
      browserWorkspaceId: 'offscreen-page-1',
      browserPageId: 'offscreen-page-1',
      url: 'https://remote.internal/',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      isActive: true
    }
    runtime.syncWindowGraph(0, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'headless:test',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: browserTab.id,
          activeTabType: 'browser',
          tabs: [browserTab]
        }
      ]
    })

    const closing = runtime.closeMobileSessionTab(
      `id:${TEST_WORKTREE_ID}`,
      browserTab.browserPageId
    )
    await vi.waitFor(() => expect(closeOffscreenTab).toHaveBeenCalledWith(browserTab.browserPageId))

    runtime.syncWindowGraph(0, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'headless:test',
          snapshotVersion: 2,
          activeGroupId: 'group-1',
          activeTabId: browserTab.id,
          activeTabType: 'browser',
          tabs: [
            browserTab,
            {
              type: 'markdown',
              id: 'notes',
              title: 'Notes',
              filePath: '/worktree/notes.md',
              relativePath: 'notes.md',
              language: 'markdown',
              mode: 'edit',
              isDirty: false,
              sourceFileId: 'notes.md',
              sourceFilePath: '/worktree/notes.md',
              sourceRelativePath: 'notes.md',
              documentVersion: '1',
              isActive: false
            }
          ]
        }
      ]
    })
    closeProof.resolve()
    await expect(closing).resolves.toEqual({ closed: true })

    expect(closeSessionTab).not.toHaveBeenCalled()
    expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([
      expect.objectContaining({ id: 'notes', type: 'markdown' })
    ])
  })

  it('creates mobile session terminals in a headless runtime server', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-headless' })
    const runtime = new OrcaRuntimeService(store)
    const persistViewMode = vi.spyOn(
      runtime as unknown as {
        persistHeadlessSessionTabProps: (
          worktreeId: string,
          tabId: string,
          props: { viewMode: 'terminal' | 'chat' }
        ) => void
      },
      'persistHeadlessSessionTabProps'
    )
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    const result = await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
      viewMode: 'chat'
    })

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: TEST_WORKTREE_PATH,
        worktreeId: TEST_WORKTREE_ID,
        tabId: expect.stringMatching(UUID_RE),
        leafId: expect.stringMatching(UUID_RE),
        persistHostSessionBinding: true,
        preAllocatedHandle: expect.stringMatching(/^term_/)
      })
    )
    expect(result.tab).toMatchObject({
      type: 'terminal',
      status: 'ready',
      terminal: expect.stringMatching(/^term_/),
      viewMode: 'chat',
      isActive: true
    })
    expect(persistViewMode).toHaveBeenCalledWith(TEST_WORKTREE_ID, result.tab.parentTabId, {
      viewMode: 'chat'
    })

    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(listed.tabs).toEqual([
      expect.objectContaining({
        id: result.tab.id,
        status: 'ready',
        terminal: result.tab.terminal
      })
    ])
  })

  it('leases renderer publication for a paired create and preserves host-owned inventory', async () => {
    const leafId = '91919191-9191-4919-8919-919191919191'
    const spawn = vi.fn()
    const setBackgroundThrottling = vi.fn()
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const webContents: {
      isDestroyed: () => boolean
      setBackgroundThrottling: typeof setBackgroundThrottling
      send: ReturnType<typeof vi.fn>
    } = {
      isDestroyed: () => false,
      setBackgroundThrottling,
      send: vi.fn()
    }
    webContents.send.mockImplementation((_channel: string, payload: { requestId: string }) => {
      expect(setBackgroundThrottling).toHaveBeenCalledWith(false)
      runtime.registerPty('pty-paired-headed', TEST_WORKTREE_ID, null, {
        tabId: 'tab-paired-headed',
        leafId
      })
      ipcMain.emit(
        'terminal:tabCreateReply',
        { sender: webContents },
        { requestId: payload.requestId, tabId: 'tab-paired-headed', title: 'Terminal' }
      )
      runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId: 'tab-paired-headed',
            worktreeId: TEST_WORKTREE_ID,
            title: 'Terminal',
            activeLeafId: leafId,
            layout: null
          }
        ],
        leaves: [
          {
            tabId: 'tab-paired-headed',
            worktreeId: TEST_WORKTREE_ID,
            leafId,
            paneRuntimeId: 1,
            ptyId: 'pty-paired-headed'
          }
        ],
        mobileSessionTabs: [
          {
            worktree: TEST_WORKTREE_ID,
            publicationEpoch: 'renderer:paired-headed',
            snapshotVersion: 1,
            activeGroupId: 'group-1',
            activeTabId: null,
            activeTabType: null,
            tabs: [
              {
                type: 'terminal',
                id: `tab-paired-headed::${leafId}`,
                parentTabId: 'tab-paired-headed',
                leafId,
                ptyId: 'pty-paired-headed',
                title: 'Terminal',
                viewMode: 'chat',
                isActive: false
              }
            ]
          }
        ]
      })
    })
    electronMocks.BrowserWindow.fromId.mockReturnValue({
      isDestroyed: () => false,
      webContents
    })

    const result = await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
      clientNavigationId: 'device-a',
      navigation: 'caller',
      activate: false,
      select: false,
      viewMode: 'chat'
    })

    expect(webContents.send).toHaveBeenCalledWith(
      'terminal:requestTabCreate',
      expect.objectContaining({ source: 'runtime-session', viewMode: 'chat' })
    )
    expect(spawn).not.toHaveBeenCalled()
    expect(setBackgroundThrottling.mock.calls).toEqual([[false], [true]])
    expect(result.tab).toMatchObject({
      type: 'terminal',
      status: 'ready',
      ptyId: 'pty-paired-headed',
      terminal: expect.stringMatching(/^term_/),
      viewMode: 'chat'
    })
    const host = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const clientA = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`, 'device-a')
    const clientB = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`, 'device-b')
    const inventory = (snapshot: RuntimeMobileSessionTabsResult) =>
      snapshot.tabs.map((tab) =>
        tab.type === 'terminal'
          ? {
              id: tab.id,
              type: tab.type,
              leafId: tab.leafId,
              parentTabId: tab.parentTabId,
              ptyId: tab.ptyId
            }
          : { id: tab.id, type: tab.type }
      )
    expect(inventory(clientA)).toEqual(inventory(host))
    expect(inventory(clientB)).toEqual(inventory(host))

    runtime['mobileSessionTabsByWorktree'].delete(TEST_WORKTREE_ID)
    expect(runtime['syncMobileSessionTabs']([])).toEqual(new Set([TEST_WORKTREE_ID]))
    expect(runtime['mobileSessionTabsByWorktree'].get(TEST_WORKTREE_ID)?.tabs).toEqual([
      expect.objectContaining({
        parentTabId: 'tab-paired-headed',
        leafId,
        ptyId: 'pty-paired-headed'
      })
    ])
    const restoredHost = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const restoredClientA = await runtime.listMobileSessionTabs(
      `id:${TEST_WORKTREE_ID}`,
      'device-a'
    )
    const restoredClientB = await runtime.listMobileSessionTabs(
      `id:${TEST_WORKTREE_ID}`,
      'device-b'
    )
    expect(inventory(restoredHost)).toEqual(inventory(host))
    expect(inventory(restoredClientA)).toEqual(inventory(host))
    expect(inventory(restoredClientB)).toEqual(inventory(host))
    expect(spawn).not.toHaveBeenCalled()
  })

  it.each([
    ['paired', 'reloading'],
    ['paired', 'unavailable'],
    ['unpaired', 'reloading'],
    ['unpaired', 'unavailable']
  ] as const)(
    'does not spawn a %s terminal while the headed renderer graph is %s',
    async (caller, graphStatus) => {
      const spawn = vi.fn()
      const send = vi.fn()
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        spawn,
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      electronMocks.BrowserWindow.fromId.mockReturnValue({
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, send, setBackgroundThrottling: vi.fn() }
      })
      if (graphStatus === 'reloading') {
        runtime.markRendererReloading(1)
      } else {
        runtime.markGraphUnavailable(1)
      }

      await expect(
        runtime.createMobileSessionTerminal(
          `id:${TEST_WORKTREE_ID}`,
          caller === 'paired'
            ? { clientNavigationId: 'device-a', navigation: 'caller' as const }
            : {}
        )
      ).rejects.toThrow('runtime_unavailable')
      expect(spawn).not.toHaveBeenCalled()
      expect(send).not.toHaveBeenCalled()
    }
  )

  it('rejects a paired create if renderer authority changes across async resolution', async () => {
    const spawn = vi.fn()
    const send = vi.fn()
    const setBackgroundThrottling = vi.fn()
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    electronMocks.BrowserWindow.fromId.mockReturnValue({
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send, setBackgroundThrottling }
    })
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    let resolutionStarted = (): void => {}
    const started = new Promise<void>((resolve) => {
      resolutionStarted = resolve
    })
    let releaseResolution = (): void => {}
    vi.mocked(listWorktrees).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseResolution = () => resolve(MOCK_GIT_WORKTREES)
          resolutionStarted()
        })
    )

    const create = runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
      clientNavigationId: 'device-a',
      navigation: 'caller'
    })
    await started
    expect(spawn).not.toHaveBeenCalled()
    runtime.markRendererReloading(1)
    releaseResolution()
    await expect(create).rejects.toThrow('runtime_unavailable')
    expect(send).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
    expect(setBackgroundThrottling).not.toHaveBeenCalled()
  })

  it('cancels a paired renderer-owned create before publication when its client disconnects', async () => {
    const spawn = vi.fn()
    const send = vi.fn()
    const setBackgroundThrottling = vi.fn()
    const abort = new AbortController()
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    electronMocks.BrowserWindow.fromId.mockReturnValue({
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send, setBackgroundThrottling }
    })
    abort.abort()

    await expect(
      runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        clientNavigationId: 'device-a',
        signal: abort.signal
      })
    ).rejects.toThrow('client_disconnected')
    expect(spawn).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(setBackgroundThrottling).not.toHaveBeenCalled()
  })

  it('selects a created terminal only for the paired caller', async () => {
    let spawnIndex = 0
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn(async () => ({ id: `pty-headless-${++spawnIndex}` })),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    const hostTerminal = await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`)

    const callerTerminal = await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
      clientNavigationId: 'device-a',
      navigation: 'caller'
    })

    expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).activeTabId).toBe(
      hostTerminal.tab.id
    )
    expect(
      (await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`, 'device-a')).activeTabId
    ).toBe(callerTerminal.tab.id)
    expect(
      (await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`, 'device-b')).activeTabId
    ).toBe(hostTerminal.tab.id)
  })

  it('scopes terminal-create idempotency to the paired caller', async () => {
    let spawnIndex = 0
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn(async () => ({ id: `pty-headless-${++spawnIndex}` })),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    const [createdA, createdB] = await Promise.all([
      runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        clientNavigationId: 'device-a',
        navigation: 'caller',
        clientMutationId: 'same-mutation'
      }),
      runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        clientNavigationId: 'device-b',
        navigation: 'caller',
        clientMutationId: 'same-mutation'
      })
    ])

    expect(createdA.tab.id).not.toBe(createdB.tab.id)
    expect(spawnIndex).toBe(2)
  })
})
