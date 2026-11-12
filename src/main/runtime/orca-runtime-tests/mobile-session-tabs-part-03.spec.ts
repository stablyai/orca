import '../../../shared/layout-owner-switch'
import { describe, expect, it, vi } from 'vitest'
import { committingSpawn } from './bind-first-pane.test-fixture'
import './runtime-test-module-registration.spec'
import { MOCK_GIT_WORKTREES, electronMocks } from '../orca-runtime-test-mocks/setup.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import '../browser/client-pages/runtime-browser-page-registry'
import 'electron'
import { listWorktrees } from '../../git/worktrees/catalog/worktree-scan-cache'
import { TEST_WORKTREE_ID, deferred, store } from './orca-runtime-test-fixtures.spec'
import '../../../shared/constants'
import './split-placement-session.test-fixture'

describe('OrcaRuntimeService', () => {
  it('closes an offscreen browser without overwriting a concurrent session update', async () => {
    const closeProof = deferred<void>()
    const closeOffscreenTab = vi.fn(() => closeProof.promise)
    const closeSessionTab = vi.fn()
    const runtime = new OrcaRuntimeService(store)
    runtime.setOffscreenBrowserBackend({
      createTab: vi.fn(),
      closeTab: closeOffscreenTab,
      ownsTab: () => true
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
    await expect(closing).resolves.toEqual({ closed: true, retirementConfirmed: true })

    expect(closeSessionTab).not.toHaveBeenCalled()
    expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([
      expect.objectContaining({ id: 'notes', type: 'markdown' })
    ])
  })

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
      webContents: {
        isDestroyed: () => false,
        send,
        setBackgroundThrottling,
        capturePage: vi.fn(async () => null)
      }
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

  it('selects a created terminal only for the paired caller', async () => {
    let spawnIndex = 0
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn(committingSpawn(runtime, async () => ({ id: `pty-headless-${++spawnIndex}` }))),
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

  it.each([false, true])(
    'scopes terminal-create idempotency to the paired caller (window available: %s)',
    async (windowAvailable) => {
      let spawnIndex = 0
      const send = vi.fn()
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        spawn: vi.fn(
          committingSpawn(runtime, async () => ({ id: `pty-headless-${++spawnIndex}` }))
        ),
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null,
        listProcesses: async () => []
      })
      if (windowAvailable) {
        runtime.attachWindow(1)
        electronMocks.BrowserWindow.fromId.mockReturnValue({
          isDestroyed: () => false,
          webContents: { send }
        })
        runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      } else {
        runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
      }

      const [createdA, createdB, duplicateA] = await Promise.all([
        runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
          clientNavigationId: 'device-a',
          navigation: 'caller',
          clientMutationId: 'same-mutation'
        }),
        runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
          clientNavigationId: 'device-b',
          navigation: 'caller',
          clientMutationId: 'same-mutation'
        }),
        runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
          clientNavigationId: 'device-a',
          navigation: 'caller',
          clientMutationId: 'same-mutation'
        })
      ])
      const retriedA = await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        clientNavigationId: 'device-a',
        navigation: 'caller',
        clientMutationId: 'same-mutation'
      })

      expect(createdA.tab.id).not.toBe(createdB.tab.id)
      expect(spawnIndex).toBe(2)
      expect(duplicateA).toBe(createdA)
      expect(retriedA).toBe(createdA)
      expect(send).not.toHaveBeenCalledWith('terminal:requestTabCreate', expect.anything())
      expect(
        (await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`, 'device-a')).activeTabId
      ).toBe(createdA.tab.id)
      expect(
        (await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`, 'device-b')).activeTabId
      ).toBe(createdB.tab.id)
    }
  )
})
