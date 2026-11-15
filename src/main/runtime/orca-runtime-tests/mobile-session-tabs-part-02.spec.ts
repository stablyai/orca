import { describe, expect, it, vi } from 'vitest'
import './runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import '../orca-runtime-test-mocks/setup.spec'
import '../../../shared/constants'

import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from './orca-runtime-test-fixtures.spec'
import '../../../shared/worktree/host-qualified-identity'

describe('OrcaRuntimeService', () => {
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
