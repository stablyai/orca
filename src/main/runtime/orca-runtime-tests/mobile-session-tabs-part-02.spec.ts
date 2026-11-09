import { describe, expect, it, vi } from 'vitest'
import './runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import { electronMocks } from '../orca-runtime-test-mocks/setup.spec'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  TEST_WINDOW_ID,
  TEST_WORKTREE_ID,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal,
  makeWorktreeMeta,
  store
} from './orca-runtime-test-fixtures.spec'
import '../../../shared/worktree/host-qualified-identity'

describe('OrcaRuntimeService', () => {
  it('reports the wake as unsupported when a phone activates a worktree on headless serve', async () => {
    // #7906: legacy headless hosts cannot wake renderer-owned sleep records; report degradation honestly.
    const metaById: Record<string, WorktreeMeta> = {
      [TEST_WORKTREE_ID]: makeWorktreeMeta({ isUnread: false })
    }
    const resumeSleepingAgents = vi.fn()
    const getWorkspaceSession = vi.fn(() => ({
      ...getDefaultWorkspaceSession(),
      sleepingAgentSessionsByPaneKey: {
        'tab-1:leaf-1': {
          paneKey: 'tab-1:leaf-1',
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'session-1' },
          prompt: 'test',
          state: 'done',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'worktree-sleep'
        }
      }
    }))
    const runtime = new OrcaRuntimeService({
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      getWorkspaceSession
    } as never)
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
      resumeSleepingAgents,
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    // Ready graph has no real BrowserWindow, keeping available authoritative window null.
    electronMocks.BrowserWindow.fromId.mockReturnValue(null as never)
    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.markGraphReady(TEST_WINDOW_ID)

    const result = await runtime.activateManagedWorktree(`id:${TEST_WORKTREE_ID}`, {
      notifyClients: false,
      clientKind: 'mobile'
    })

    expect(result.activated).toBe(true)
    expect(result.sleepingAgentWake).toBe('unsupported-headless')
    // Sleep records belong to the repo's execution-host partition.
    expect(getWorkspaceSession).toHaveBeenCalledWith('local')
    expect(resumeSleepingAgents).not.toHaveBeenCalled()
  })

  it('materializes phone-local pending terminal tabs without stored PTY bindings', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'fresh-mobile-pty' })
    const focusTerminal = vi.fn()
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'host-tab',
              ptyId: null,
              worktreeId: TEST_WORKTREE_ID,
              title: 'Persisted Terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        terminalLayoutsByTabId: {
          'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: undefined })
        }
      })
    )
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal,
      closeTerminal: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const activated = await runtime.activateMobileSessionTab(
      `id:${TEST_WORKTREE_ID}`,
      'host-tab',
      HEADLESS_LEAF_ID,
      { notifyClients: false }
    )

    expect(focusTerminal).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: TEST_WORKTREE_ID,
        tabId: 'host-tab',
        leafId: HEADLESS_LEAF_ID,
        sessionId: expect.stringMatching(/@@serve-/),
        isNewSession: true,
        persistHostSessionBinding: true
      })
    )
    expect(activated.tabs).toEqual([
      expect.objectContaining({
        id: `host-tab::${HEADLESS_LEAF_ID}`,
        status: 'ready',
        terminal: expect.any(String)
      })
    ])
  })

  it('keeps the target group active when phone-local activation materializes a tab', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'group-target-pty' })
    const focusTerminal = vi.fn()
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        activeTabIdByWorktree: { [TEST_WORKTREE_ID]: 'host-tab' },
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'host-tab',
              ptyId: null,
              worktreeId: TEST_WORKTREE_ID,
              title: 'Left',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            },
            {
              id: 'host-tab-2',
              ptyId: null,
              worktreeId: TEST_WORKTREE_ID,
              title: 'Right',
              customTitle: null,
              color: null,
              sortOrder: 1,
              createdAt: 2
            }
          ]
        },
        terminalLayoutsByTabId: {
          'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: undefined }),
          'host-tab-2': makeHeadlessTerminalLayout({ [HEADLESS_SECOND_LEAF_ID]: undefined })
        },
        tabGroups: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'group-left',
              worktreeId: TEST_WORKTREE_ID,
              activeTabId: 'host-tab',
              tabOrder: ['host-tab']
            },
            {
              id: 'group-right',
              worktreeId: TEST_WORKTREE_ID,
              activeTabId: 'host-tab-2',
              tabOrder: ['host-tab-2']
            }
          ]
        }
      })
    )
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal,
      closeTerminal: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const activated = await runtime.activateMobileSessionTab(
      `id:${TEST_WORKTREE_ID}`,
      'host-tab-2',
      HEADLESS_SECOND_LEAF_ID,
      { notifyClients: false }
    )

    expect(focusTerminal).not.toHaveBeenCalled()
    expect(activated.activeGroupId).toBe('group-right')
    expect(activated.tabGroups).toEqual([
      expect.objectContaining({ id: 'group-left', activeTabId: 'host-tab' }),
      expect.objectContaining({ id: 'group-right', activeTabId: 'host-tab-2' })
    ])
    expect(activated.activeTabId).toBe(`host-tab-2::${HEADLESS_SECOND_LEAF_ID}`)
  })

  it('refreshes stale daemon liveness before phone-local terminal materialization', async () => {
    const stalePtyId = `${TEST_WORKTREE_ID}@@stale-mobile-pty`
    const spawn = vi.fn().mockResolvedValue({ id: stalePtyId })
    const listProcesses = vi.fn(async () => [])
    const focusTerminal = vi.fn()
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'host-tab',
              ptyId: stalePtyId,
              worktreeId: TEST_WORKTREE_ID,
              title: 'Persisted Terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        terminalLayoutsByTabId: {
          'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: stalePtyId })
        }
      })
    )
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.registerPty(stalePtyId, TEST_WORKTREE_ID)
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal,
      closeTerminal: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses
    })

    const activated = await runtime.activateMobileSessionTab(
      `id:${TEST_WORKTREE_ID}`,
      'host-tab',
      HEADLESS_LEAF_ID,
      { notifyClients: false }
    )

    expect(listProcesses).toHaveBeenCalled()
    expect(focusTerminal).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: stalePtyId,
        tabId: 'host-tab',
        leafId: HEADLESS_LEAF_ID
      })
    )
    expect(activated.tabs).toEqual([
      expect.objectContaining({
        id: `host-tab::${HEADLESS_LEAF_ID}`,
        status: 'ready',
        terminal: expect.any(String)
      })
    ])
  })
})
