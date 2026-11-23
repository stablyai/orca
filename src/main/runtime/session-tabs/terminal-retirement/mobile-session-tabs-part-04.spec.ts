import '../../construction/test-context/runtime-durable-store-fixture'
import { describe, expect, it, vi } from 'vitest'
import '../../terminal/layout/bind-first-pane.test-fixture'
import '../../construction/test-context/runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../../orca-runtime'
import { electronMocks } from '../../orca-runtime-test-mocks/setup.spec'
import '../publication/mobile-session-tab-event-wait'
import { getDefaultWorkspaceSession } from '../../../../shared/orca-profiles/constants'
import 'node:path'
import 'node:fs/promises'
import 'node:os'

import {
  HEADLESS_LEAF_ID,
  TEST_REPO_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession
} from '../../construction/test-context/orca-runtime-test-fixtures.spec'
import '../../terminal/launch/spawned-pty-env-fixtures'

describe('OrcaRuntimeService', () => {
  it('keeps a live headed runtime-owned tab until its explicit close', async () => {
    const ptyId = 'local-runtime-owned-pty'
    const splitPtyId = 'local-runtime-owned-split-pty'
    const tabId = 'runtime-session-tab'
    const leafId = HEADLESS_LEAF_ID
    const kill = vi.fn(() => true)
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      activeRepoId: TEST_REPO_ID,
      activeWorktreeId: TEST_WORKTREE_ID,
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [
          {
            id: tabId,
            ptyId: null,
            worktreeId: TEST_WORKTREE_ID,
            title: 'Codex',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            launchAgent: 'codex'
          }
        ]
      },
      terminalLayoutsByTabId: {
        [tabId]: makeHeadlessTerminalLayout({ [leafId]: undefined })
      }
    })
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValueOnce({ id: ptyId }).mockResolvedValueOnce({ id: splitPtyId }),
      write: () => true,
      kill,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: ptyId,
          cwd: TEST_WORKTREE_PATH,
          title: 'Codex',
          worktreeId: TEST_WORKTREE_ID
        },
        {
          id: splitPtyId,
          cwd: TEST_WORKTREE_PATH,
          title: 'Codex',
          worktreeId: TEST_WORKTREE_ID
        }
      ]
    })
    const publishRendererOmission = async (snapshotVersion: number): Promise<void> => {
      await runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [],
        mobileSessionTabs: [
          {
            worktree: TEST_WORKTREE_ID,
            publicationEpoch: 'headed-runtime',
            snapshotVersion,
            activeGroupId: 'group-1',
            activeTabId: null,
            activeTabType: null,
            tabs: []
          }
        ]
      })
    }
    runtime.attachWindow(1)
    await publishRendererOmission(1)
    electronMocks.BrowserWindow.fromId.mockReturnValue({
      isDestroyed: () => false,
      webContents: { send: vi.fn() }
    })

    const created = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      presentation: 'background',
      tabId,
      leafId,
      launchAgent: 'codex'
    })
    const split = await runtime.splitTerminal(created.handle, { direction: 'vertical' })
    await publishRendererOmission(2)

    expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: `${tabId}::${leafId}`,
          parentTabId: tabId,
          ptyId,
          status: 'ready',
          terminal: created.handle
        }),
        expect.objectContaining({
          parentTabId: tabId,
          ptyId: splitPtyId,
          status: 'ready',
          terminal: split.handle
        })
      ])
    )
    expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toHaveLength(2)

    await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, tabId, { reason: 'user' })
    await publishRendererOmission(3)

    expect(kill).toHaveBeenCalledWith(ptyId)
    expect(kill).toHaveBeenCalledWith(splitPtyId)
    expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([])
  })
})
