import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import { withDurableRuntimeStore } from './runtime-durable-store-fixture'
import { describe, expect, it, vi } from 'vitest'
import './bind-first-pane.test-fixture'
import './runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import { electronMocks } from '../orca-runtime-test-mocks/setup.spec'
import './mobile-session-tab-event-wait'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import 'node:path'
import 'node:fs/promises'
import 'node:os'

import {
  HEADLESS_LEAF_ID,
  TEST_REPO_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal,
  store
} from './orca-runtime-test-fixtures.spec'
import '../terminal/launch/spawned-pty-env-fixtures'

describe('OrcaRuntimeService', () => {
  it('closes a headless SSH tab only in its SSH workspace-session partition', async () => {
    const sshPtyId = 'ssh:ssh-1@@remote-pty'
    const localSession = makeWorkspaceSessionWithHeadlessTerminal()
    let sshSession = makeWorkspaceSessionWithHeadlessTerminal({
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'ssh-host-tab',
            ptyId: sshPtyId,
            worktreeId: TEST_WORKTREE_ID,
            title: 'SSH host terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        'ssh-host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: sshPtyId })
      }
    })
    const remoteRepo = { ...store.getRepo(TEST_REPO_ID)!, connectionId: 'ssh-1' }
    const setWorkspaceSession = vi.fn((session: WorkspaceSessionState, hostId?: string | null) => {
      expect(hostId).toBe('ssh:ssh-1')
      sshSession = session
    })
    const kill = vi.fn(() => true)
    const runtime = new OrcaRuntimeService(
      withDurableRuntimeStore({
        ...store,
        getRepos: () => [remoteRepo],
        getRepo: (id: string) => (id === TEST_REPO_ID ? remoteRepo : undefined),
        getWorkspaceSession: (hostId?: string | null) =>
          hostId === 'ssh:ssh-1' ? sshSession : localSession,
        setWorkspaceSession,
        flushOrThrow: vi.fn()
      })
    )
    runtime.setPtyController({
      write: () => true,
      kill,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    await runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'ssh-host-tab')

    expect(sshSession.tabsByWorktree[TEST_WORKTREE_ID]).toEqual([])
    expect(localSession.tabsByWorktree[TEST_WORKTREE_ID]).toHaveLength(1)
    expect(setWorkspaceSession).toHaveBeenCalledTimes(1)
    expect(kill).toHaveBeenCalledWith(sshPtyId)
  })

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
    publishRendererOmission(1)
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
    publishRendererOmission(2)

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
    publishRendererOmission(3)

    expect(kill).toHaveBeenCalledWith(ptyId)
    expect(kill).toHaveBeenCalledWith(splitPtyId)
    expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([])
  })
})
