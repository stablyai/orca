import { describe, expect, it, vi } from 'vitest'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { committingSpawn, registerLivePty } from '../bind-first-pane.test-fixture'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import type { WorkspaceSessionState } from '../orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  deferred,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal,
  store
} from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  describe('close intent adjudication', () => {
    function makeAdoptedLiveTabRuntime(): {
      runtime: OrcaRuntimeService
      getSession: () => WorkspaceSessionState
      kill: ReturnType<typeof vi.fn>
      closeTerminal: ReturnType<typeof vi.fn>
      closeTerminalTab: ReturnType<typeof vi.fn>
      listProcesses: ReturnType<typeof vi.fn>
      processes: { id: string; cwd: string; title: string }[]
    } {
      const servePtyId = 'serve-live-1'
      const processes = [{ id: servePtyId, cwd: TEST_WORKTREE_PATH, title: 'Live' }]
      const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
        makeWorkspaceSessionWithHeadlessTerminal({
          tabsByWorktree: {
            [TEST_WORKTREE_ID]: [
              {
                id: 'host-tab',
                ptyId: servePtyId,
                worktreeId: TEST_WORKTREE_ID,
                title: 'Live Terminal',
                customTitle: null,
                color: null,
                sortOrder: 0,
                createdAt: 1
              }
            ]
          },
          terminalLayoutsByTabId: {
            'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: servePtyId })
          }
        })
      )
      const kill = vi.fn(() => true)
      const closeTerminal = vi.fn()
      const closeTerminalTab = vi.fn(async () => {})
      const listProcesses = vi.fn(async () => processes)
      const runtime = new OrcaRuntimeService(runtimeStore as never)
      runtime.setPtyController({
        write: () => true,
        kill,
        getForegroundProcess: async () => null,
        listProcesses
      })
      runtime.setNotifier({ closeTerminal, closeTerminalTab } as never)
      runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId: 'host-tab',
            worktreeId: TEST_WORKTREE_ID,
            title: 'Live Terminal',
            activeLeafId: HEADLESS_LEAF_ID,
            layout: null
          }
        ],
        leaves: [
          {
            tabId: 'host-tab',
            worktreeId: TEST_WORKTREE_ID,
            leafId: HEADLESS_LEAF_ID,
            paneRuntimeId: 1,
            ptyId: servePtyId
          }
        ]
      })
      return {
        runtime,
        getSession,
        kill,
        closeTerminal,
        closeTerminalTab,
        listProcesses,
        processes
      }
    }

    it.each(['pty-exit', 'cleanup'] as const)(
      'refuses a %s echoed close while the PTY is live and republishes the snapshot',
      async (reason) => {
        const { runtime, getSession, kill, closeTerminal, closeTerminalTab } =
          makeAdoptedLiveTabRuntime()
        const before = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
        const events: { worktree: string; snapshotVersion: number; tabs: unknown[] }[] = []
        const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

        const result = await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', {
          reason
        })

        unsubscribe()
        expect(result).toEqual({
          closed: true,
          refused: true,
          refusalReason: 'live-host-pty',
          snapshotRepublished: true
        })
        expect(kill).not.toHaveBeenCalled()
        expect(closeTerminalTab).not.toHaveBeenCalled()
        expect(closeTerminal).not.toHaveBeenCalled()
        expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toHaveLength(1)
        // Republishing a newer snapshot lets an echoing client reattach the still-live tab.
        const republished = events.filter((event) => event.worktree === TEST_WORKTREE_ID)
        expect(republished.length).toBeGreaterThan(0)
        const last = republished.at(-1)!
        expect(last.snapshotVersion).toBeGreaterThan(before.snapshotVersion)
        expect(
          last.tabs.some((tab) => (tab as { parentTabId?: string }).parentTabId === 'host-tab')
        ).toBe(true)
      }
    )

    it('coalesces a reconnect close burst onto one authoritative PTY inventory', async () => {
      const { runtime, listProcesses, processes } = makeAdoptedLiveTabRuntime()
      const inventory = deferred<typeof processes>()
      listProcesses.mockImplementation(() => inventory.promise)

      const closes = Promise.all([
        runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', {
          reason: 'pty-exit'
        }),
        runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', {
          reason: 'cleanup'
        })
      ])
      await vi.waitFor(() => expect(listProcesses).toHaveBeenCalledTimes(1))
      inventory.resolve(processes)

      await expect(closes).resolves.toEqual([
        expect.objectContaining({ refused: true, refusalReason: 'live-host-pty' }),
        expect.objectContaining({ refused: true, refusalReason: 'live-host-pty' })
      ])
      expect(listProcesses).toHaveBeenCalledTimes(1)
    })

    it('keeps a live persisted PTY whose pane binding has not reconnected yet', async () => {
      const ptyId = 'persisted-pty'
      const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
        makeWorkspaceSessionWithHeadlessTerminal({
          tabsByWorktree: {
            [TEST_WORKTREE_ID]: [
              {
                id: 'host-tab',
                ptyId,
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
            'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: ptyId })
          }
        })
      )
      const kill = vi.fn(() => true)
      const runtime = new OrcaRuntimeService(runtimeStore as never)
      runtime.setPtyController({
        write: () => true,
        kill,
        getForegroundProcess: async () => null,
        listProcesses: async () => [{ id: ptyId, cwd: TEST_WORKTREE_PATH, title: 'Live' }]
      })

      const result = await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', {
        reason: 'cleanup'
      })

      expect(result).toEqual({
        closed: true,
        refused: true,
        refusalReason: 'live-host-pty',
        snapshotRepublished: true
      })
      expect(kill).not.toHaveBeenCalled()
      expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toHaveLength(1)
      expect(getSession().terminalLayoutsByTabId['host-tab']).toBeDefined()
    })

    it('keeps an explicit user close destructive while the PTY is live', async () => {
      const { runtime, closeTerminalTab, kill, getSession } = makeAdoptedLiveTabRuntime()

      await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', {
        reason: 'user'
      })

      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        expect(closeTerminalTab).not.toHaveBeenCalled()
        expect(kill).toHaveBeenCalledWith('serve-live-1')
        expect(getSession().terminalLayoutsByTabId['host-tab']).toBeUndefined()
        return
      }
      expect(closeTerminalTab).toHaveBeenCalledWith('host-tab')
    })

    it('keeps a reasonless legacy close and republishes its live mirror', async () => {
      const { runtime, kill, closeTerminal, closeTerminalTab } = makeAdoptedLiveTabRuntime()
      const before = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

      const result = await runtime.refuseUnattributedMobileSessionTabClose(
        `id:${TEST_WORKTREE_ID}`,
        'host-tab'
      )
      const after = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

      expect(result).toEqual({
        closed: true,
        refused: true,
        refusalReason: 'missing-intent',
        snapshotRepublished: true
      })
      expect(after.snapshotVersion).toBeGreaterThan(before.snapshotVersion)
      expect(kill).not.toHaveBeenCalled()
      expect(closeTerminalTab).not.toHaveBeenCalled()
      expect(closeTerminal).not.toHaveBeenCalled()
    })

    it('refuses a lifecycle close from a stale host publication', async () => {
      const { runtime, kill, closeTerminal, closeTerminalTab } = makeAdoptedLiveTabRuntime()
      const current = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
      const terminal = current.tabs.find((tab) => tab.type === 'terminal')
      if (!terminal || terminal.status !== 'ready') {
        throw new Error('expected a ready terminal fixture')
      }

      const result = await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', {
        reason: 'pty-exit',
        expectedPublicationEpoch: 'stale-epoch',
        expectedTerminalHandle: terminal.terminal
      })

      expect(result).toEqual({
        closed: true,
        refused: true,
        refusalReason: 'stale-publication',
        snapshotRepublished: true
      })
      expect(kill).not.toHaveBeenCalled()
      expect(closeTerminalTab).not.toHaveBeenCalled()
      expect(closeTerminal).not.toHaveBeenCalled()
    })

    it('refuses a reused tab id that names a different terminal incarnation', async () => {
      const { runtime, kill, closeTerminal, closeTerminalTab } = makeAdoptedLiveTabRuntime()
      const current = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

      const result = await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', {
        reason: 'pty-exit',
        expectedPublicationEpoch: current.publicationEpoch,
        expectedTerminalHandle: 'term-from-retired-incarnation'
      })

      expect(result).toEqual({
        closed: true,
        refused: true,
        refusalReason: 'stale-terminal',
        snapshotRepublished: true
      })
      expect(kill).not.toHaveBeenCalled()
      expect(closeTerminalTab).not.toHaveBeenCalled()
      expect(closeTerminal).not.toHaveBeenCalled()
    })

    it('leaves dead renderer-owned retirement to the renderer without relaying a close', async () => {
      const { runtime, processes, kill, closeTerminal, closeTerminalTab } =
        makeAdoptedLiveTabRuntime()
      const current = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
      const terminal = current.tabs.find((tab) => tab.type === 'terminal')
      if (!terminal || terminal.status !== 'ready') {
        throw new Error('expected a ready terminal fixture')
      }
      runtime.onPtyExit('serve-live-1', 0)
      processes.length = 0

      const result = await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', {
        reason: 'pty-exit',
        expectedPublicationEpoch: current.publicationEpoch,
        expectedTerminalHandle: terminal.terminal
      })

      expect(result).toEqual({
        closed: true,
        refused: true,
        refusalReason: 'retirement-owner'
      })
      expect(kill).not.toHaveBeenCalled()
      expect(closeTerminalTab).not.toHaveBeenCalled()
      expect(closeTerminal).not.toHaveBeenCalled()
    })

    function makeSplitLeafRuntime(): {
      runtime: OrcaRuntimeService
      getSession: () => WorkspaceSessionState
      kill: ReturnType<typeof vi.fn>
      closeTerminal: ReturnType<typeof vi.fn>
      exitShell: (ptyId: string) => Promise<void>
    } {
      const layout = makeHeadlessTerminalLayout({
        [HEADLESS_LEAF_ID]: 'serve-left',
        [HEADLESS_SECOND_LEAF_ID]: 'serve-right'
      })
      const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
        makeWorkspaceSessionWithHeadlessTerminal({
          tabsByWorktree: {
            [TEST_WORKTREE_ID]: [
              {
                id: 'host-tab',
                ptyId: 'serve-left',
                worktreeId: TEST_WORKTREE_ID,
                title: 'Split Terminal',
                customTitle: null,
                color: null,
                sortOrder: 0,
                createdAt: 1
              }
            ]
          },
          terminalLayoutsByTabId: { 'host-tab': layout }
        })
      )
      const kill = vi.fn(() => true)
      const closeTerminal = vi.fn()
      const liveShells = new Set(['serve-left', 'serve-right'])
      const runtime = new OrcaRuntimeService(runtimeStore as never)
      runtime.setPtyController({
        write: () => true,
        kill,
        getForegroundProcess: async () => null,
        listProcesses: async () =>
          [...liveShells].map((id) => ({
            id,
            title: 'shell',
            cwd: TEST_WORKTREE_PATH,
            worktreeId: TEST_WORKTREE_ID,
            wslDistro: null
          }))
      })
      runtime.setNotifier({ closeTerminal } as never)
      runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId: 'host-tab',
            worktreeId: TEST_WORKTREE_ID,
            title: 'Split Terminal',
            activeLeafId: HEADLESS_LEAF_ID,
            layout: null
          }
        ],
        leaves: [
          {
            tabId: 'host-tab',
            worktreeId: TEST_WORKTREE_ID,
            leafId: HEADLESS_LEAF_ID,
            paneRuntimeId: 1,
            ptyId: 'serve-left',
            paneTitle: 'L'
          },
          {
            tabId: 'host-tab',
            worktreeId: TEST_WORKTREE_ID,
            leafId: HEADLESS_SECOND_LEAF_ID,
            paneRuntimeId: 2,
            ptyId: 'serve-right',
            paneTitle: 'R'
          }
        ]
      })
      for (const [leafId, ptyId] of [
        [HEADLESS_LEAF_ID, 'serve-left'],
        [HEADLESS_SECOND_LEAF_ID, 'serve-right']
      ]) {
        registerLivePty(runtime, ptyId, TEST_WORKTREE_ID, null, { tabId: 'host-tab', leafId })
      }
      const exitShell = async (ptyId: string): Promise<void> => {
        liveShells.delete(ptyId)
        await runtime.onPtyExit(ptyId, 0)
      }
      return { runtime, getSession, kill, closeTerminal, exitShell }
    }

    it('refuses a pty-exit echoed close of a live split leaf (direct-kill branch)', async () => {
      const { runtime, getSession, kill, closeTerminal } = makeSplitLeafRuntime()

      await runtime.closeMobileSessionTab(
        `id:${TEST_WORKTREE_ID}`,
        `host-tab::${HEADLESS_SECOND_LEAF_ID}`,
        { reason: 'pty-exit' }
      )

      expect(kill).not.toHaveBeenCalled()
      expect(closeTerminal).not.toHaveBeenCalled()
      expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toHaveLength(1)
      expect(getSession().terminalLayoutsByTabId['host-tab']).toBeDefined()
    })

    it('still kills a live split leaf for an explicit user close', async () => {
      const { runtime, kill } = makeSplitLeafRuntime()

      await runtime.closeMobileSessionTab(
        `id:${TEST_WORKTREE_ID}`,
        `host-tab::${HEADLESS_SECOND_LEAF_ID}`,
        { reason: 'user' }
      )

      expect(kill).toHaveBeenCalledWith('serve-right')
      expect(kill).not.toHaveBeenCalledWith('serve-left')
    })

    it('refuses without republishing when the echoed leaf is dead but a sibling is live', async () => {
      // Refusing a dead split leaf must not republish it into a refuse/republish/echo loop.
      const { runtime, getSession, kill, closeTerminal, exitShell } = makeSplitLeafRuntime()
      await exitShell('serve-right')
      const events: { worktree: string }[] = []
      const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

      const result = await runtime.closeMobileSessionTab(
        `id:${TEST_WORKTREE_ID}`,
        `host-tab::${HEADLESS_SECOND_LEAF_ID}`,
        { reason: 'pty-exit' }
      )

      unsubscribe()
      expect(result).toEqual({
        closed: true,
        refused: true,
        refusalReason: 'live-host-pty'
      })
      expect(kill).not.toHaveBeenCalled()
      expect(closeTerminal).not.toHaveBeenCalled()
      expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toHaveLength(1)
      expect(events.filter((event) => event.worktree === TEST_WORKTREE_ID)).toEqual([])
    })

    it('refuses a pty-exit echoed close of a runtime-owned headless tab with a live PTY', async () => {
      // A live headless parent must survive an echo; its close path kills every sibling.
      const servePtyId = 'serve-headless-live'
      const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
        makeWorkspaceSessionWithHeadlessTerminal({
          tabsByWorktree: {
            [TEST_WORKTREE_ID]: [
              {
                id: 'host-tab',
                ptyId: servePtyId,
                worktreeId: TEST_WORKTREE_ID,
                title: 'Serve Terminal',
                customTitle: null,
                color: null,
                sortOrder: 0,
                createdAt: 1
              }
            ]
          },
          terminalLayoutsByTabId: {
            'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: servePtyId })
          }
        })
      )
      const kill = vi.fn(() => true)
      const closeTerminal = vi.fn()
      const runtime = new OrcaRuntimeService(runtimeStore as never)
      runtime.setPtyController({
        write: () => true,
        kill,
        getForegroundProcess: async () => null,
        listProcesses: async () => []
      })
      runtime.setNotifier({ closeTerminal } as never)
      runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId: 'host-tab',
            worktreeId: TEST_WORKTREE_ID,
            title: 'Serve Terminal',
            activeLeafId: HEADLESS_LEAF_ID,
            layout: null
          }
        ],
        leaves: [
          {
            tabId: 'host-tab',
            worktreeId: TEST_WORKTREE_ID,
            leafId: HEADLESS_LEAF_ID,
            paneRuntimeId: 1,
            ptyId: servePtyId,
            paneTitle: 'A'
          }
        ]
      })

      await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', {
        reason: 'pty-exit'
      })

      expect(kill).not.toHaveBeenCalled()
      expect(closeTerminal).not.toHaveBeenCalled()
      expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toHaveLength(1)
      expect(getSession().terminalLayoutsByTabId['host-tab']).toBeDefined()
    })

    // Main-owned retirement currently refuses the dead-tab echo; this branch is an expected failure.
    ;(ORCA_LAYOUT_OWNER_IS_MAIN ? it.fails : it)(
      'retires a dead headless tab on a pty-exit echoed close',
      async () => {
        // Headless hosts rely on client exit echoes to retire dead tab records.
        const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
          makeWorkspaceSessionWithHeadlessTerminal()
        )
        const kill = vi.fn(() => true)
        const runtime = new OrcaRuntimeService(runtimeStore as never)
        runtime.setPtyController({
          write: () => true,
          kill,
          getForegroundProcess: async () => null,
          listProcesses: async () => []
        })
        runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

        await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', {
          reason: 'pty-exit'
        })

        expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([])
        expect(getSession().terminalLayoutsByTabId['host-tab']).toBeUndefined()
      }
    )

    it('retires a dead headless tab whose exited PTY still has a retained record', async () => {
      // onPtyExit retains disconnected records; record presence alone must not count as liveness.
      const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
        makeWorkspaceSessionWithHeadlessTerminal()
      )
      const processes: { id: string; cwd: string; title: string }[] = [
        { id: 'persisted-pty', cwd: TEST_WORKTREE_PATH, title: 'Shell' }
      ]
      const kill = vi.fn(() => true)
      const runtime = new OrcaRuntimeService(runtimeStore as never)
      runtime.setPtyController({
        write: () => true,
        kill,
        getForegroundProcess: async () => null,
        listProcesses: async () => processes
      })
      runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
      await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
      runtime.onPtyExit('persisted-pty', 0)
      processes.length = 0

      await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', {
        reason: 'pty-exit'
      })

      expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([])
      expect(getSession().terminalLayoutsByTabId['host-tab']).toBeUndefined()
      expect(kill).not.toHaveBeenCalled()
    })

    it('keeps a headless tab when the provider inventory is unavailable', async () => {
      const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
        makeWorkspaceSessionWithHeadlessTerminal()
      )
      const kill = vi.fn(() => true)
      const runtime = new OrcaRuntimeService(runtimeStore as never)
      runtime.setPtyController({
        write: () => true,
        kill,
        getForegroundProcess: async () => null,
        listProcesses: async () => {
          throw new Error('access denied')
        }
      })
      runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

      const result = await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', {
        reason: 'pty-exit'
      })

      expect(result).toEqual({
        closed: true,
        refused: true,
        refusalReason: 'unknown-liveness',
        snapshotRepublished: true
      })
      expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toHaveLength(1)
      expect(getSession().terminalLayoutsByTabId['host-tab']).toBeDefined()
      expect(kill).not.toHaveBeenCalled()
    })
  })

  it('builds mobile session agent launch commands on the runtime host', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-agent' })
    const runtime = new OrcaRuntimeService({
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        disabledTuiAgents: [],
        agentCmdOverrides: { 'command-code': 'command-code --profile mobile' },
        agentDefaultEnv: { 'command-code': { COMMAND_CODE_PROFILE: 'mobile-env' } }
      })
    } as never)
    runtime.setPtyController({
      spawn: committingSpawn(runtime, spawn),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
      agent: 'command-code'
    })

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "command-code --profile mobile '--yolo'",
        cwd: TEST_WORKTREE_PATH,
        env: expect.objectContaining({
          COMMAND_CODE_PROFILE: 'mobile-env'
        }),
        worktreeId: TEST_WORKTREE_ID
      })
    )
  })

  it('injects mobile quick-command prompts into the host-built agent startup command', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-agent-prompt' })
    const runtime = new OrcaRuntimeService({
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        disabledTuiAgents: [],
        agentCmdOverrides: { codex: 'codex' },
        agentDefaultArgs: {}
      })
    } as never)
    runtime.setPtyController({
      spawn: committingSpawn(runtime, spawn),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
      agent: 'codex',
      agentPrompt: 'Review this diff'
    })

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.stringMatching(/^codex .*'Review this diff'$/),
        launchAgent: 'codex',
        cwd: TEST_WORKTREE_PATH
      })
    )
  })
})
