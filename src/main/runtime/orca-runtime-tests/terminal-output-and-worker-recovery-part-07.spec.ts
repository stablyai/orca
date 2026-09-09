import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService, getDefaultWorkspaceSession } from '../orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  HEADLESS_THIRD_LEAF_ID,
  TEST_REPO_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal,
  store,
  withPlatform
} from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('keeps current-generation tab and leaf identity across a host restart', async () => {
    const session = makeWorkspaceSessionWithHeadlessTerminal({
      terminalPtyIncarnationsByPaneKey: {
        [`host-tab:${HEADLESS_LEAF_ID}`]: 'inc-current'
      },
      terminalTopologyRevisionByRepoId: { [TEST_REPO_ID]: 4 }
    })
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(session)
    let connected = true
    const writes: [string, string][] = []
    const resize = vi.fn(() => true)
    const makeRuntime = (): OrcaRuntimeService => {
      const runtime = new OrcaRuntimeService(runtimeStore as never)
      runtime.setPtyController({
        write: (ptyId, data) => {
          writes.push([ptyId, data])
          return true
        },
        resize,
        kill: () => true,
        getForegroundProcess: async () => null,
        listProcesses: async () =>
          connected
            ? [
                {
                  id: 'persisted-pty',
                  incarnationId: 'inc-current',
                  terminalHandle: 'term_current',
                  title: 'Current shell',
                  cwd: TEST_WORKTREE_PATH,
                  worktreeId: TEST_WORKTREE_ID,
                  wslDistro: null
                }
              ]
            : []
      })
      runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
      return runtime
    }

    const originalRuntime = makeRuntime()
    const beforeRestart = await originalRuntime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    connected = false
    const disconnected = await originalRuntime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    connected = true
    const reconnected = await originalRuntime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const restarted = makeRuntime()
    const afterRestart = await restarted.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const listed = await restarted.listTerminals(`id:${TEST_WORKTREE_ID}`)
    restarted.onPtyData('persisted-pty', 'after restart\n', 1)
    await restarted.sendTerminal('term_current', { text: 'input' })
    await restarted.updateRemoteDesktopViewer('persisted-pty', 'viewer', 'client', 132, 41)

    expect(beforeRestart.tabs[0]).toMatchObject({
      parentTabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID,
      status: 'ready',
      terminal: 'term_current',
      title: 'Persisted Terminal'
    })
    expect(afterRestart.tabs[0]).toMatchObject({
      parentTabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID,
      status: 'ready',
      terminal: 'term_current'
    })
    expect(disconnected.tabs[0]).toMatchObject({ status: 'pending-handle', terminal: null })
    expect(reconnected.tabs[0]).toMatchObject({
      parentTabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID,
      status: 'ready',
      terminal: 'term_current'
    })
    expect(listed.terminals[0]).toMatchObject({
      tabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID,
      incarnationId: 'inc-current',
      orphaned: false
    })
    expect(listed.topologyRevisions?.[TEST_WORKTREE_ID]).toBe(4)
    await expect(restarted.readTerminal('term_current')).resolves.toMatchObject({
      tail: ['after restart']
    })
    expect(writes).toEqual([['persisted-pty', 'input']])
    expect(resize).toHaveBeenCalledWith('persisted-pty', 132, 41)
  })

  it('uses topology CAS before a client can claim a still-orphaned PTY', async () => {
    const session = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [TEST_WORKTREE_ID]: [] },
      terminalTopologyRevisionByRepoId: { [TEST_REPO_ID]: 7 }
    }
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService({ ...runtimeStore, flushOrThrow: vi.fn() } as never)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'pty-cas',
          incarnationId: 'inc-cas',
          terminalHandle: 'term_cas',
          title: 'shell',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        }
      ]
    })

    await expect(
      runtime.adoptTerminalOrphans({
        worktree: `id:${TEST_WORKTREE_ID}`,
        expectedTopologyRevision: 6,
        claims: [
          {
            terminal: 'term_cas',
            ptyId: 'pty-cas',
            incarnationId: 'inc-cas',
            tabId: 'tab-cas',
            leafId: HEADLESS_LEAF_ID
          }
        ]
      })
    ).rejects.toThrow('terminal_topology_conflict')
  })

  it('keeps orphaned list and show writability aligned with the send gate', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [TEST_WORKTREE_ID]: [] }
    })
    const runtime = new OrcaRuntimeService({ ...runtimeStore, flushOrThrow: vi.fn() } as never)
    const writes: [string, string][] = []
    runtime.setPtyController({
      write: (ptyId: string, data: string) => {
        writes.push([ptyId, data])
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'pty-orphan',
          incarnationId: 'inc-orphan',
          terminalHandle: 'term_orphan',
          title: 'shell',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        }
      ]
    } as never)
    runtime.registerPty('pty-orphan', TEST_WORKTREE_ID)
    runtime.onPtySpawned('pty-orphan', 'inc-orphan', { awaitsRegistration: false })

    const listed = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    const entry = listed.terminals.find((terminal) => terminal.ptyId === 'pty-orphan')
    expect(entry).toMatchObject({ orphaned: true, connected: true, writable: true })

    const shown = await runtime.showTerminal(entry!.handle)
    expect(shown.writable).toBe(true)
    await expect(runtime.sendTerminal(entry!.handle, { text: 'hi' })).resolves.toMatchObject({
      accepted: true
    })
    expect(writes).toEqual([['pty-orphan', 'hi']])
  })

  it('rejects connection mismatch and reused handles while allowing a WSL-owned orphan', async () => {
    const makeRuntime = (): OrcaRuntimeService => {
      const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
        ...getDefaultWorkspaceSession(),
        tabsByWorktree: { [TEST_WORKTREE_ID]: [] }
      })
      return new OrcaRuntimeService({ ...runtimeStore, flushOrThrow: vi.fn() } as never)
    }
    const ownerMismatch = makeRuntime()
    ownerMismatch.registerPty('pty-wrong-owner', TEST_WORKTREE_ID, 'ssh-other-host')
    ownerMismatch.onPtySpawned('pty-wrong-owner', 'inc-owner', { awaitsRegistration: false })
    ownerMismatch.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'pty-wrong-owner',
          incarnationId: 'inc-owner',
          terminalHandle: 'term_wrong_owner',
          title: 'shell',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        }
      ]
    })
    await expect(
      ownerMismatch.adoptTerminalOrphans({
        worktree: `id:${TEST_WORKTREE_ID}`,
        expectedTopologyRevision: 0,
        claims: [
          {
            terminal: 'term_wrong_owner',
            ptyId: 'pty-wrong-owner',
            incarnationId: 'inc-owner',
            tabId: 'tab-owner',
            leafId: HEADLESS_LEAF_ID
          }
        ]
      })
    ).rejects.toThrow('terminal_orphan_owner_mismatch')

    const reusedHandle = makeRuntime()
    for (const [ptyId, incarnationId] of [
      ['pty-first', 'inc-first'],
      ['pty-second', 'inc-second']
    ] as const) {
      reusedHandle.registerPty(ptyId, TEST_WORKTREE_ID)
      reusedHandle.onPtySpawned(ptyId, incarnationId, { awaitsRegistration: false })
    }
    reusedHandle.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'pty-first',
          incarnationId: 'inc-first',
          terminalHandle: 'term_reused',
          title: 'shell',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        },
        {
          id: 'pty-second',
          incarnationId: 'inc-second',
          terminalHandle: 'term_reused',
          title: 'shell',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        }
      ]
    })
    await expect(
      reusedHandle.adoptTerminalOrphans({
        worktree: `id:${TEST_WORKTREE_ID}`,
        expectedTopologyRevision: 0,
        claims: [
          {
            terminal: 'term_reused',
            ptyId: 'pty-second',
            incarnationId: 'inc-second',
            tabId: 'tab-second',
            leafId: HEADLESS_LEAF_ID
          }
        ]
      })
    ).rejects.toThrow('terminal_orphan_stale')

    await withPlatform('win32', async () => {
      const makeWslRuntime = (reportedWslDistro?: string | null): OrcaRuntimeService => {
        const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
          ...getDefaultWorkspaceSession(),
          tabsByWorktree: { [TEST_WORKTREE_ID]: [] }
        })
        const wsl = new OrcaRuntimeService({
          ...runtimeStore,
          flushOrThrow: vi.fn(),
          getProjects: () => [
            {
              id: 'project-wsl',
              displayName: 'WSL',
              badgeColor: 'blue',
              sourceRepoIds: [TEST_REPO_ID],
              localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' },
              createdAt: 1,
              updatedAt: 1
            }
          ],
          getSettings: () => ({
            ...store.getSettings(),
            localWindowsRuntimeDefault: { kind: 'windows-host' }
          })
        } as never)
        wsl.registerPty('pty-wsl', TEST_WORKTREE_ID, null, undefined, true)
        wsl.onPtySpawned('pty-wsl', 'inc-wsl', { awaitsRegistration: false })
        wsl.setPtyController({
          write: () => true,
          kill: () => true,
          getForegroundProcess: async () => null,
          listProcesses: async () => [
            {
              id: 'pty-wsl',
              incarnationId: 'inc-wsl',
              terminalHandle: 'term_wsl',
              title: 'shell',
              cwd: TEST_WORKTREE_PATH,
              worktreeId: TEST_WORKTREE_ID,
              ...(reportedWslDistro !== undefined ? { wslDistro: reportedWslDistro } : {})
            }
          ]
        })
        return wsl
      }
      const request = {
        worktree: `id:${TEST_WORKTREE_ID}`,
        expectedTopologyRevision: 0,
        claims: [
          {
            terminal: 'term_wsl',
            ptyId: 'pty-wsl',
            incarnationId: 'inc-wsl',
            tabId: 'tab-wsl',
            leafId: HEADLESS_LEAF_ID
          }
        ]
      }

      await expect(makeWslRuntime('Ubuntu').adoptTerminalOrphans(request)).resolves.toMatchObject({
        adopted: true,
        topologyRevision: 1
      })
      await expect(makeWslRuntime('Debian').adoptTerminalOrphans(request)).rejects.toThrow(
        'terminal_orphan_owner_mismatch'
      )
      await expect(makeWslRuntime().adoptTerminalOrphans(request)).rejects.toThrow(
        'terminal_orphan_owner_mismatch'
      )
    })
  })

  it('preserves legacy pane and group topology without changing host focus', async () => {
    const session = {
      ...getDefaultWorkspaceSession(),
      activeWorktreeId: 'other-worktree',
      activeTabId: 'other-tab',
      tabsByWorktree: { [TEST_WORKTREE_ID]: [] }
    }
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService({ ...runtimeStore, flushOrThrow: vi.fn() } as never)
    const processes = [
      ['pty-left', 'inc-left', 'term_left'],
      ['pty-right', 'inc-right', 'term_right'],
      ['pty-shell', 'inc-shell', 'term_shell']
    ] as const
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () =>
        processes.map(([id, incarnationId, terminalHandle]) => ({
          id,
          incarnationId,
          terminalHandle,
          title: id,
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        }))
    })

    await runtime.adoptTerminalOrphans({
      worktree: `id:${TEST_WORKTREE_ID}`,
      expectedTopologyRevision: 0,
      activeTabId: 'tab-agent',
      activeGroupId: 'group-left',
      claims: processes.map(([ptyId, incarnationId, terminal], index) => ({
        terminal,
        ptyId,
        incarnationId,
        tabId: index < 2 ? 'tab-agent' : 'tab-shell',
        leafId: [HEADLESS_LEAF_ID, HEADLESS_SECOND_LEAF_ID, HEADLESS_THIRD_LEAF_ID][index]!
      })),
      topology: {
        tabs: [
          {
            tabId: 'tab-agent',
            root: {
              type: 'split',
              direction: 'horizontal',
              ratio: 0.35,
              first: { type: 'leaf', leafId: HEADLESS_LEAF_ID },
              second: { type: 'leaf', leafId: HEADLESS_SECOND_LEAF_ID }
            },
            activeLeafId: HEADLESS_SECOND_LEAF_ID,
            expandedLeafId: HEADLESS_SECOND_LEAF_ID
          },
          {
            tabId: 'tab-shell',
            root: { type: 'leaf', leafId: HEADLESS_THIRD_LEAF_ID },
            activeLeafId: HEADLESS_THIRD_LEAF_ID,
            expandedLeafId: null
          }
        ],
        groups: [
          {
            id: 'group-left',
            activeTabId: 'tab-agent',
            tabOrder: ['tab-agent'],
            recentTabIds: ['tab-agent']
          },
          { id: 'group-right', activeTabId: 'tab-shell', tabOrder: ['tab-shell'] }
        ],
        groupLayout: {
          type: 'split',
          direction: 'vertical',
          ratio: 0.6,
          first: { type: 'leaf', groupId: 'group-left' },
          second: { type: 'leaf', groupId: 'group-right' }
        }
      }
    })

    expect(getSession()).toMatchObject({
      activeWorktreeId: 'other-worktree',
      activeTabId: 'other-tab',
      activeTabIdByWorktree: { [TEST_WORKTREE_ID]: 'tab-agent' },
      activeGroupIdByWorktree: { [TEST_WORKTREE_ID]: 'group-left' },
      tabGroups: {
        [TEST_WORKTREE_ID]: [
          { id: 'group-left', activeTabId: 'tab-agent', tabOrder: ['tab-agent'] },
          { id: 'group-right', activeTabId: 'tab-shell', tabOrder: ['tab-shell'] }
        ]
      },
      tabGroupLayouts: {
        [TEST_WORKTREE_ID]: expect.objectContaining({
          type: 'split',
          direction: 'vertical',
          ratio: 0.6
        })
      },
      terminalLayoutsByTabId: {
        'tab-agent': expect.objectContaining({
          root: expect.objectContaining({
            type: 'split',
            direction: 'horizontal',
            ratio: 0.35
          }),
          activeLeafId: HEADLESS_SECOND_LEAF_ID,
          expandedLeafId: HEADLESS_SECOND_LEAF_ID
        })
      }
    })
  })
})
