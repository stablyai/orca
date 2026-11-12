import { withDurableRuntimeStore } from './runtime-durable-store-fixture'
import { describe, expect, it, vi } from 'vitest'
import { committingSpawn } from './bind-first-pane.test-fixture'
import './runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import { electronMocks } from '../orca-runtime-test-mocks/setup.spec'
import { waitForMobileSessionTabsEvents } from './mobile-session-tab-event-wait'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import 'node:path'
import 'node:fs/promises'
import 'node:os'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-session-contracts'

import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
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
  it('hydrates an SSH worktree only from its SSH workspace-session partition', async () => {
    const localSession = makeWorkspaceSessionWithHeadlessTerminal({
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'local-decoy-tab',
            ptyId: 'local-decoy-pty',
            worktreeId: TEST_WORKTREE_ID,
            title: 'Local decoy',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        'local-decoy-tab': makeHeadlessTerminalLayout({
          [HEADLESS_LEAF_ID]: 'local-decoy-pty'
        })
      }
    })
    const sshPtyId = 'ssh:ssh-1@@remote-pty'
    const sshSession = makeWorkspaceSessionWithHeadlessTerminal({
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
    const getWorkspaceSession = vi.fn((hostId?: string | null) =>
      hostId === 'ssh:ssh-1' ? sshSession : localSession
    )
    const runtime = new OrcaRuntimeService(
      withDurableRuntimeStore({
        ...store,
        flushOrThrow: vi.fn(),
        getRepos: () => [remoteRepo],
        getRepo: (id: string) => (id === TEST_REPO_ID ? remoteRepo : undefined),
        getWorkspaceSession
      })
    )
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(listed.tabs).toEqual([
      expect.objectContaining({ parentTabId: 'ssh-host-tab', ptyId: sshPtyId })
    ])
    expect(listed.tabs).not.toEqual([expect.objectContaining({ parentTabId: 'local-decoy-tab' })])
    expect(getWorkspaceSession).toHaveBeenCalledWith('ssh:ssh-1')
  })

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
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

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
    const publishRendererOmission = (snapshotVersion: number): void => {
      runtime.syncWindowGraph(1, {
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

  it('publishes laptop-created remote runtime terminals to phone session tabs', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'laptop-created-pty' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'renderer-empty',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: null,
          activeTabType: null,
          tabs: []
        }
      ]
    })

    const laptopTerminal = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      command: "claude 'work on the issue'",
      tabId: 'laptop-tab',
      leafId: HEADLESS_LEAF_ID
    })
    runtime.onPtyData('laptop-created-pty', '\x1b]0;Codex working\x07', Date.now())
    runtime.onPtyData('laptop-created-pty', 'Claude is working...\r\n', Date.now())

    const phoneTabs = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(laptopTerminal.surface).toBe('background')
    expect(phoneTabs.tabs).toEqual([
      expect.objectContaining({
        type: 'terminal',
        parentTabId: 'laptop-tab',
        leafId: HEADLESS_LEAF_ID,
        status: 'ready',
        terminal: laptopTerminal.handle,
        agentStatus: expect.objectContaining({
          state: 'working',
          paneKey: `laptop-tab:${HEADLESS_LEAF_ID}`,
          terminalHandle: laptopTerminal.handle
        })
      })
    ])
    await expect(runtime.readTerminal(laptopTerminal.handle)).resolves.toMatchObject({
      tail: ['Claude is working...']
    })
  })

  it('keeps background-presentation PTY-backed mobile session tabs inactive', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'laptop-created-pty' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      activate: true,
      presentation: 'background',
      tabId: 'laptop-tab',
      leafId: HEADLESS_LEAF_ID
    })

    const phoneTabs = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(phoneTabs.activeTabId).toBeNull()
    expect(phoneTabs.tabs[0]).toMatchObject({
      type: 'terminal',
      id: `laptop-tab::${HEADLESS_LEAF_ID}`,
      isActive: false
    })
  })

  it('replaces pending phone session tabs when a laptop-created remote PTY becomes live', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'laptop-created-pty' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'renderer-pending',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: `laptop-tab::${HEADLESS_LEAF_ID}`,
          activeTabType: 'terminal',
          tabGroups: [{ id: 'group-1', activeTabId: 'laptop-tab', tabOrder: ['laptop-tab'] }],
          tabs: [
            {
              type: 'terminal',
              id: `laptop-tab::${HEADLESS_LEAF_ID}`,
              parentTabId: 'laptop-tab',
              leafId: HEADLESS_LEAF_ID,
              title: 'Starting Claude',
              isActive: true
            }
          ]
        }
      ]
    })

    const laptopTerminal = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'laptop-tab',
      leafId: HEADLESS_LEAF_ID
    })

    const phoneTabs = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(phoneTabs.tabs).toHaveLength(1)
    expect(phoneTabs.tabs[0]).toMatchObject({
      type: 'terminal',
      id: `laptop-tab::${HEADLESS_LEAF_ID}`,
      status: 'ready',
      terminal: laptopTerminal.handle
    })
  })

  it('pushes PTY-backed mobile session tab title and agent status changes to subscribers', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'laptop-created-pty' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: committingSpawn(runtime, spawn),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const events: RuntimeMobileSessionTabsResult[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

    const laptopTerminal = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'laptop-tab',
      leafId: HEADLESS_LEAF_ID
    })
    events.length = 0

    runtime.onPtyData('laptop-created-pty', '\x1b]0;Claude working\x07', 123)
    runtime.onPtyData('laptop-created-pty', '\x1b]0;Claude waiting for permission\x07', 124)

    await waitForMobileSessionTabsEvents(events, 1)
    expect(events).toEqual([
      expect.objectContaining({
        tabs: [
          expect.objectContaining({
            type: 'terminal',
            agentStatus: expect.objectContaining({
              state: 'blocked',
              terminalHandle: laptopTerminal.handle
            })
          })
        ]
      })
    ])

    unsubscribe()
  })

  it('does not publish stale PTY-backed mobile agent status for Claude agents screens', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'laptop-created-pty' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: committingSpawn(runtime, spawn),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude'
    })
    const events: RuntimeMobileSessionTabsResult[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'laptop-tab',
      leafId: HEADLESS_LEAF_ID
    })
    events.length = 0

    runtime.onPtyData('laptop-created-pty', '\x1b]0;Claude working\x07', 123)
    runtime.onPtyData('laptop-created-pty', '\x1b]0;claude agents\x07', 124)

    await waitForMobileSessionTabsEvents(events, 1)
    expect(events[0]?.tabs[0]).toEqual(
      expect.objectContaining({
        type: 'terminal',
        title: 'claude agents'
      })
    )
    expect(events[0]?.tabs[0]).not.toHaveProperty('agentStatus')

    unsubscribe()
  })
})
