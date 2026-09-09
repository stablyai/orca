import { describe, expect, it, vi } from 'vitest'
import {
  OrcaRuntimeService,
  electronMocks,
  waitForMobileSessionTabsEvents
} from '../orca-runtime-test-mocks.spec'
import type {
  RuntimeMobileSessionTabsResult,
  SleepingAgentSessionRecord,
  WorkspaceSessionState
} from '../orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  TEST_REPO_ID,
  TEST_WINDOW_ID,
  TEST_WORKTREE_ID,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal,
  store
} from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  describe('deliberately parked pane activation (STA-3465)', () => {
    function makeParkedSessionStore(
      origin: SleepingAgentSessionRecord['origin'] | undefined,
      overrides: Partial<SleepingAgentSessionRecord> = {},
      ownerHostId = 'local'
    ) {
      return makeRuntimeStoreWithWorkspaceSession(
        makeWorkspaceSessionWithHeadlessTerminal({
          sleepingAgentSessionsByPaneKey: {
            [`host-tab:${HEADLESS_LEAF_ID}`]: {
              paneKey: `host-tab:${HEADLESS_LEAF_ID}`,
              tabId: 'host-tab',
              worktreeId: TEST_WORKTREE_ID,
              agent: 'claude',
              providerSession: { key: 'session_id', id: 'provider-session-1' },
              prompt: 'do the thing',
              state: 'done',
              capturedAt: 1,
              updatedAt: 1,
              ...(origin ? { origin } : {}),
              ...overrides
            } as SleepingAgentSessionRecord
          }
        }),
        ownerHostId
      )
    }

    function makeParkedRuntime(runtimeStore: unknown): {
      runtime: OrcaRuntimeService
      spawn: ReturnType<typeof vi.fn>
    } {
      const spawn = vi.fn().mockResolvedValue({ id: 'persisted-pty' })
      const runtime = new OrcaRuntimeService(runtimeStore as never)
      runtime.setPtyController({
        spawn,
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null,
        listProcesses: async () => []
      })
      runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
      return { runtime, spawn }
    }

    function setParkedRuntimeNotifier(
      runtime: OrcaRuntimeService,
      resumeSleepingAgents: (worktreeId: string) => void
    ): void {
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
        sleepWorktree: vi.fn(),
        resumeSleepingAgents,
        terminalFitOverrideChanged: vi.fn(),
        terminalDriverChanged: vi.fn()
      })
      runtime.attachWindow(TEST_WINDOW_ID)
      runtime.markGraphReady(TEST_WINDOW_ID)
    }

    const userActivate = (
      runtime: OrcaRuntimeService,
      leafId?: string
    ): Promise<RuntimeMobileSessionTabsResult> =>
      runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', leafId, {
        notifyClients: false,
        navigation: 'caller',
        intent: 'user'
      })

    const automaticActivate = (
      runtime: OrcaRuntimeService,
      leafId?: string
    ): Promise<RuntimeMobileSessionTabsResult> =>
      runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', leafId, {
        notifyClients: false,
        navigation: 'caller',
        intent: 'automatic'
      })

    it('refuses an automatic reconnect probe for a deliberately slept pane', async () => {
      const { runtimeStore } = makeParkedSessionStore('worktree-sleep')
      const { runtime, spawn } = makeParkedRuntime(runtimeStore)

      const activated = await automaticActivate(runtime)

      expect(spawn).not.toHaveBeenCalled()
      expect(activated.tabs[0]).toMatchObject({
        type: 'terminal',
        parentTabId: 'host-tab',
        leafId: HEADLESS_LEAF_ID,
        status: 'pending-handle',
        terminal: null
      })
      // Negative safety: refusing to wake must not retire the surface either.
      expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs[0]).toMatchObject(
        { parentTabId: 'host-tab', status: 'pending-handle' }
      )
    })

    it('refuses an automatic probe that carries the leafId the probe sends', async () => {
      const { runtimeStore } = makeParkedSessionStore('worktree-sleep')
      const { runtime, spawn } = makeParkedRuntime(runtimeStore)

      const activated = await automaticActivate(runtime, HEADLESS_LEAF_ID)

      expect(spawn).not.toHaveBeenCalled()
      expect(activated.tabs[0]).toMatchObject({ status: 'pending-handle', terminal: null })
    })

    // Why: opening the tab is the documented wake gesture for a slept pane
    // (#11598). These four cover every topology, because three of them never
    // clear the record — the pane's own activation is the only thing that wakes it.
    it('materializes a slept pane for a user tap under headless serve, which never wakes', async () => {
      const { runtimeStore, getSession } = makeParkedSessionStore('worktree-sleep')
      const resumeSleepingAgents = vi.fn()
      const { runtime, spawn } = makeParkedRuntime(runtimeStore)
      setParkedRuntimeNotifier(runtime, resumeSleepingAgents)
      electronMocks.BrowserWindow.fromId.mockReturnValue(null as never)

      const worktreeActivation = await runtime.activateManagedWorktree(`id:${TEST_WORKTREE_ID}`, {
        notifyClients: false,
        clientKind: 'mobile'
      })

      expect(worktreeActivation.sleepingAgentWake).toBe('unsupported-headless')
      expect(resumeSleepingAgents).not.toHaveBeenCalled()
      expect(
        getSession().sleepingAgentSessionsByPaneKey?.[`host-tab:${HEADLESS_LEAF_ID}`]?.origin
      ).toBe('worktree-sleep')

      const activated = await userActivate(runtime, HEADLESS_LEAF_ID)

      expect(spawn).toHaveBeenCalledOnce()
      expect(activated.tabs[0]).toMatchObject({ status: 'ready' })
    })

    it('materializes a slept pane for a paired desktop client tab click, which asks for no wake', async () => {
      const { runtimeStore, getSession } = makeParkedSessionStore('worktree-sleep')
      const resumeSleepingAgents = vi.fn()
      const { runtime, spawn } = makeParkedRuntime(runtimeStore)
      setParkedRuntimeNotifier(runtime, resumeSleepingAgents)
      electronMocks.BrowserWindow.fromId.mockReturnValue({ isDestroyed: () => false } as never)

      await runtime.activateManagedWorktree(`id:${TEST_WORKTREE_ID}`, {
        notifyClients: false,
        clientKind: 'runtime'
      })

      expect(resumeSleepingAgents).not.toHaveBeenCalled()
      expect(
        getSession().sleepingAgentSessionsByPaneKey?.[`host-tab:${HEADLESS_LEAF_ID}`]
      ).toBeDefined()

      const activated = await userActivate(runtime)

      expect(spawn).toHaveBeenCalledOnce()
      expect(activated.tabs[0]).toMatchObject({ status: 'ready' })
    })

    // Why: manual sleep of a finished agent stamps restoreOnTabOpenOnly, which the
    // background wake skips and resume classifies pane-owned, so the record survives.
    it('materializes a slept pane whose completed-agent record is restore-on-tab-open-only', async () => {
      const { runtimeStore } = makeParkedSessionStore('worktree-sleep', {
        state: 'done',
        restoreOnTabOpenOnly: true
      })
      const { runtime, spawn } = makeParkedRuntime(runtimeStore)

      const activated = await userActivate(runtime)

      expect(spawn).toHaveBeenCalledOnce()
      expect(activated.tabs[0]).toMatchObject({ status: 'ready' })
    })

    // Why: manual sleep of a running agent is the one topology whose wake relaunches
    // and clears the record, so the pane must materialize with the record gone too.
    it('materializes a slept running-agent pane after its wake cleared the record', async () => {
      const { runtimeStore, getSession, setSession } = makeParkedSessionStore('worktree-sleep', {
        state: 'working'
      })
      const { runtime, spawn } = makeParkedRuntime(runtimeStore)
      const woken = structuredClone(getSession())
      delete woken.sleepingAgentSessionsByPaneKey?.[`host-tab:${HEADLESS_LEAF_ID}`]
      setSession(woken)

      const activated = await userActivate(runtime)

      expect(spawn).toHaveBeenCalledOnce()
      expect(activated.tabs[0]).toMatchObject({ status: 'ready' })
    })

    // Why: the field is additive, so a client that predates it sends nothing and
    // must keep its wake gesture rather than silently losing it.
    it('treats an absent intent as a user activation', async () => {
      const { runtimeStore } = makeParkedSessionStore('worktree-sleep')
      const { runtime, spawn } = makeParkedRuntime(runtimeStore)

      const activated = await runtime.activateMobileSessionTab(
        `id:${TEST_WORKTREE_ID}`,
        'host-tab',
        undefined,
        { notifyClients: false, navigation: 'caller' }
      )

      expect(spawn).toHaveBeenCalledOnce()
      expect(activated.tabs[0]).toMatchObject({ status: 'ready' })
    })

    // Why: #11542's reconnect fix depends on an automatic activate materializing a
    // genuinely awaiting pane. These four prove the park guard did not break it.
    it('still materializes a pane awaiting reconnect with no sleeping record', async () => {
      const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
        makeWorkspaceSessionWithHeadlessTerminal()
      )
      const { runtime, spawn } = makeParkedRuntime(runtimeStore)

      const activated = await automaticActivate(runtime)

      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          tabId: 'host-tab',
          leafId: HEADLESS_LEAF_ID,
          sessionId: 'persisted-pty'
        })
      )
      expect(activated.tabs[0]).toMatchObject({ status: 'ready' })
    })

    it('still materializes a pane whose record was captured while it was live', async () => {
      const { runtimeStore } = makeParkedSessionStore('live')
      const { runtime, spawn } = makeParkedRuntime(runtimeStore)

      const activated = await automaticActivate(runtime)

      expect(spawn).toHaveBeenCalledOnce()
      expect(activated.tabs[0]).toMatchObject({ status: 'ready' })
    })

    it('still materializes a pane whose record was captured at app quit', async () => {
      const { runtimeStore } = makeParkedSessionStore('quit')
      const { runtime, spawn } = makeParkedRuntime(runtimeStore)

      const activated = await automaticActivate(runtime)

      expect(spawn).toHaveBeenCalledOnce()
      expect(activated.tabs[0]).toMatchObject({ status: 'ready' })
    })

    it('ignores a park record that belongs to a different worktree', async () => {
      const { runtimeStore } = makeParkedSessionStore('worktree-sleep', {
        worktreeId: 'other-repo::/other'
      })
      const { runtime, spawn } = makeParkedRuntime(runtimeStore)

      const activated = await automaticActivate(runtime)

      expect(spawn).toHaveBeenCalledOnce()
      expect(activated.tabs[0]).toMatchObject({ status: 'ready' })
    })

    // Why: sleeping records live in the owning execution host's session partition,
    // so reading a fixed partition would miss the record on an SSH-host worktree.
    it('reads the park record from the worktree own execution-host partition', async () => {
      const sshRepo = { ...store.getRepos()[0]!, executionHostId: 'ssh:ssh-1' as const }
      const { runtimeStore } = makeParkedSessionStore('worktree-sleep', {}, 'ssh:ssh-1')
      const { runtime, spawn } = makeParkedRuntime({
        ...runtimeStore,
        getRepos: () => [sshRepo],
        getRepo: (id: string) => (id === TEST_REPO_ID ? sshRepo : undefined)
      })

      const activated = await automaticActivate(runtime)

      expect(spawn).not.toHaveBeenCalled()
      expect(activated.tabs[0]).toMatchObject({ status: 'pending-handle', terminal: null })
    })
  })

  it('reattaches hydrated SSH headless terminals with the persisted relay identity', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'host-tab',
              ptyId: 'ssh:ssh-1@@relay-pty',
              worktreeId: TEST_WORKTREE_ID,
              title: 'Remote Terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        terminalLayoutsByTabId: {
          'host-tab': makeHeadlessTerminalLayout({
            [HEADLESS_LEAF_ID]: 'ssh:ssh-1@@relay-pty'
          })
        }
      }),
      'ssh:ssh-1'
    )
    const remoteRepo = { ...store.getRepo(TEST_REPO_ID)!, connectionId: 'ssh-1' }
    const remoteStore = {
      ...runtimeStore,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === TEST_REPO_ID ? remoteRepo : undefined)
    }
    const spawn = vi.fn().mockResolvedValue({ id: 'ssh:ssh-1@@relay-pty', isReattach: true })
    const runtime = new OrcaRuntimeService(remoteStore as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab')

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: 'ssh-1',
        tabId: 'host-tab',
        leafId: HEADLESS_LEAF_ID,
        sessionId: 'ssh:ssh-1@@relay-pty',
        persistHostSessionBinding: true
      })
    )
  })

  it('spawns fresh after an expired hydrated SSH headless reattach clears persistence', async () => {
    const stalePtyId = 'ssh:ssh-1@@relay-pty'
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'host-tab',
              ptyId: stalePtyId,
              worktreeId: TEST_WORKTREE_ID,
              title: 'Remote Terminal',
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
      }),
      'ssh:ssh-1'
    )
    const remoteRepo = { ...store.getRepo(TEST_REPO_ID)!, connectionId: 'ssh-1' }
    const remoteStore = {
      ...runtimeStore,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === TEST_REPO_ID ? remoteRepo : undefined)
    }
    const spawn = vi
      .fn()
      .mockImplementationOnce(async () => {
        const session = getSession()
        ;(runtimeStore.setWorkspaceSession as unknown as (next: WorkspaceSessionState) => void)({
          ...session,
          tabsByWorktree: {
            ...session.tabsByWorktree,
            [TEST_WORKTREE_ID]: session.tabsByWorktree[TEST_WORKTREE_ID].map((tab) =>
              tab.id === 'host-tab' ? { ...tab, ptyId: null } : tab
            )
          },
          terminalLayoutsByTabId: {
            ...session.terminalLayoutsByTabId,
            'host-tab': {
              ...session.terminalLayoutsByTabId['host-tab'],
              ptyIdsByLeafId: {}
            }
          }
        })
        throw new Error('SSH session expired')
      })
      .mockResolvedValueOnce({ id: 'ssh:ssh-1@@fresh-pty' })
    const runtime = new OrcaRuntimeService(remoteStore as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await expect(
      runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab')
    ).rejects.toThrow('SSH session expired')
    await runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab')

    expect(spawn).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        connectionId: 'ssh-1',
        sessionId: stalePtyId
      })
    )
    expect(spawn.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        connectionId: 'ssh-1',
        tabId: 'host-tab',
        leafId: HEADLESS_LEAF_ID,
        persistHostSessionBinding: true
      })
    )
    expect(spawn.mock.calls[1]?.[0]).not.toHaveProperty('sessionId')
  })

  it('keeps the activated headless tab active across PTY republishes (serve focus-jump regression)', async () => {
    // Why: in `orca serve`, focusTerminal has no renderer to persist the remote client's tab choice before PTY republishes.
    let nextPty = 0
    const spawn = vi.fn().mockImplementation(async () => ({ id: `headless-pty-${++nextPty}` }))
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const FIRST_LEAF = '22222222-2222-4222-8222-222222222222'
    const SECOND_LEAF = '33333333-3333-4333-8333-333333333333'
    // The first-created headless terminal is the one the snapshot marks active.
    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'tab-first',
      leafId: FIRST_LEAF
    })
    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'tab-other',
      leafId: SECOND_LEAF
    })

    const events: RuntimeMobileSessionTabsResult[] = []
    runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

    // The remote client switches to the other (non-active) tab.
    await runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'tab-other')

    const afterActivate = events.at(-1)
    expect(afterActivate?.activeTabId).toBe(`tab-other::${SECOND_LEAF}`)
    expect(afterActivate?.activeTabType).toBe('terminal')
    expect(afterActivate?.tabGroups?.[0]?.activeTabId).toBe('tab-other')
    expect(
      afterActivate?.tabs.find((tab) => tab.id === `tab-other::${SECOND_LEAF}`)?.isActive
    ).toBe(true)
    expect(afterActivate?.tabs.find((tab) => tab.id === `tab-first::${FIRST_LEAF}`)?.isActive).toBe(
      false
    )

    // PTY title updates republish snapshots, so the client's chosen tab must survive activation.
    events.length = 0
    runtime.onPtyData('headless-pty-2', '\x1b]0;tab-other running\x07', 200)

    await waitForMobileSessionTabsEvents(events, 1)
    const afterPtyData = events.at(-1)
    expect(afterPtyData?.activeTabId).toBe(`tab-other::${SECOND_LEAF}`)
    expect(afterPtyData?.activeTabType).toBe('terminal')
    expect(afterPtyData?.tabGroups?.[0]?.activeTabId).toBe('tab-other')
  })

  it('does not bump the snapshot version when re-activating the already-active headless tab', async () => {
    // Why: redundant activations of the current tab must not force a remote re-render.
    const spawn = vi.fn().mockResolvedValue({ id: 'headless-pty-solo' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const LEAF = '44444444-4444-4444-8444-444444444444'
    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, { tabId: 'tab-solo', leafId: LEAF })

    const events: RuntimeMobileSessionTabsResult[] = []
    runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

    await runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'tab-solo')

    expect(events).toHaveLength(0)
  })

  it('does not persist active server-side when an authoritative renderer is attached', async () => {
    // Why: an authoritative renderer re-syncs the snapshot itself, so the headless persist must not fire — the renderer stays source of truth.
    let nextPty = 0
    const spawn = vi.fn().mockImplementation(async () => ({ id: `attached-pty-${++nextPty}` }))
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const LEAF_A = '55555555-5555-4555-8555-555555555555'
    const LEAF_B = '66666666-6666-4666-8666-666666666666'
    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, { tabId: 'tab-a', leafId: LEAF_A })
    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, { tabId: 'tab-b', leafId: LEAF_B })

    // Make an authoritative renderer window present.
    runtime.attachWindow(1)
    runtime.markGraphReady(1)
    electronMocks.BrowserWindow.fromId.mockReturnValue({
      isDestroyed: () => false,
      webContents: { send: vi.fn() }
    })

    const events: RuntimeMobileSessionTabsResult[] = []
    runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

    await runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'tab-b')

    // The headless persist is gated off by the authoritative window — nothing emitted.
    expect(events).toHaveLength(0)
  })

  it('does not persist active server-side for a `:headless-merge:` snapshot after renderer detach', async () => {
    // Why: after renderer detach, merged snapshots have no authoritative window but still carry renderer-owned group state.
    let nextPty = 0
    const spawn = vi.fn().mockImplementation(async () => ({ id: `merge-pty-${++nextPty}` }))
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const LEAF_A = '77777777-7777-4777-8777-777777777777'
    const LEAF_B = '88888888-8888-4888-8888-888888888888'
    // tab-a (first-created) is the snapshot's active tab.
    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, { tabId: 'tab-a', leafId: LEAF_A })
    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, { tabId: 'tab-b', leafId: LEAF_B })

    // Simulate a post-detach merged snapshot with no authoritative window.
    const current = runtime['mobileSessionTabsByWorktree'].get(TEST_WORKTREE_ID)!
    runtime['mobileSessionTabsByWorktree'].set(TEST_WORKTREE_ID, {
      ...current,
      publicationEpoch: `renderer:headless-merge:${current.publicationEpoch}`
    })

    const events: RuntimeMobileSessionTabsResult[] = []
    runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

    // The merge exclusion must suppress server-side active rewrites.
    await runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'tab-b')

    expect(events).toHaveLength(0)
  })

  it('spawns fresh SSH terminals when hydrated persistence has no relay identity', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'host-tab',
              ptyId: null,
              worktreeId: TEST_WORKTREE_ID,
              title: 'Remote Terminal',
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
      }),
      'ssh:ssh-1'
    )
    const remoteRepo = { ...store.getRepo(TEST_REPO_ID)!, connectionId: 'ssh-1' }
    const remoteStore = {
      ...runtimeStore,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === TEST_REPO_ID ? remoteRepo : undefined)
    }
    const spawn = vi.fn().mockResolvedValue({ id: 'ssh:ssh-1@@fresh-pty' })
    const runtime = new OrcaRuntimeService(remoteStore as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab')

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: 'ssh-1',
        tabId: 'host-tab',
        leafId: HEADLESS_LEAF_ID,
        persistHostSessionBinding: true
      })
    )
    expect(spawn.mock.calls[0]?.[0]).not.toHaveProperty('sessionId')
  })

  it('materializes the requested hydrated split leaf instead of the first sibling', async () => {
    const layout = makeHeadlessTerminalLayout({
      [HEADLESS_LEAF_ID]: 'pty-a',
      [HEADLESS_SECOND_LEAF_ID]: 'pty-b'
    })
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'host-tab',
              ptyId: 'pty-a',
              worktreeId: TEST_WORKTREE_ID,
              title: 'Persisted Split Terminal',
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
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-b' })
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    const activated = await runtime.activateMobileSessionTab(
      `id:${TEST_WORKTREE_ID}`,
      'host-tab',
      HEADLESS_SECOND_LEAF_ID
    )

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: 'host-tab',
        leafId: HEADLESS_SECOND_LEAF_ID,
        sessionId: 'pty-b'
      })
    )
    expect(activated.tabs).toContainEqual(
      expect.objectContaining({
        type: 'terminal',
        parentTabId: 'host-tab',
        leafId: HEADLESS_SECOND_LEAF_ID,
        status: 'ready'
      })
    )
  })
})
