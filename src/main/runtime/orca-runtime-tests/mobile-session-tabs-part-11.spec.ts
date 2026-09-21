import { describe, expect, it, vi } from 'vitest'
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
    // Shared setup: a renderer-adopted tab whose PTY the host sees alive.
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
        // No destructive branch may run: no PTY kill, no renderer close relay.
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
        // The snapshot is republished (version bumped) so the echoing client
        // re-adds and re-attaches the still-live tab.
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
      const { runtime, closeTerminalTab } = makeAdoptedLiveTabRuntime()

      await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', {
        reason: 'user'
      })

      // Legacy whole-parent relay: the renderer close transaction still runs.
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
      return { runtime, getSession, kill, closeTerminal }
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
      // Why: the only reachable close path for a single leaf destroys the whole
      // parent (live sibling included), so the close must be refused — but a
      // republish would re-add the dead leaf on the echoing client and feed a
      // refuse→republish→re-echo loop.
      const { runtime, getSession, kill, closeTerminal } = makeSplitLeafRuntime()
      runtime.onPtyExit('serve-right', 0)
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
      // Why: the headless close path kills every leaf PTY and de-persists the
      // parent; an echo must not reach it while the host sees the PTY alive.
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

    it('retires a dead headless tab on a pty-exit echoed close', async () => {
      // Why: headless hosts have no renderer pty-exit handling of their own;
      // they rely on the client echo to retire genuinely dead tab records.
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
    })

    it('retires a dead headless tab whose exited PTY still has a retained record', async () => {
      // Why: onPtyExit keeps the disconnected record in ptysById for status and
      // exit reads — the production state after a real exit. The gate must not
      // read record presence as liveness or the dead tab never retires and the
      // client echo loops.
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
      // Seed the connected PTY record from the controller listing, then let the
      // process die: the record flips to disconnected but stays retained.
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
      spawn,
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
      spawn,
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
