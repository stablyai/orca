import { afterEach, describe, expect, it, vi } from 'vitest'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { OrcaRuntimeService } from './orca-runtime'

afterEach(() => setStructuredAgentSessionHost(null))

describe('structured session cold restoration', () => {
  it('publishes a versioned title change and derives listAll titles from the record', async () => {
    const runtime = new OrcaRuntimeService()
    runtime.replaceStructuredAgentSessionTab({
      sourceSessionId: 'source-session',
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      agent: 'claude'
    })
    const before = await runtime.listMobileSessionTabs('id:workspace-1')
    let name: string | undefined = 'auth/login'
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: title projection reads only the record and replacement list from this host stub.
    setStructuredAgentSessionHost({
      deps: {
        store: {
          getRecord: () => ({ location: { workspaceId: 'workspace-1' }, conversationName: name })
        }
      },
      conversationReplacements: () => []
    } as never)
    const listed = await runtime.listAllMobileSessionTabs()
    expect(listed.find((row) => row.worktree === 'workspace-1')?.tabs[0]?.title).toBe('auth/login')
    const events: { snapshotVersion: number; tabs: { title: string }[] }[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => {
      if (snapshot.worktree === 'workspace-1') {
        events.push(snapshot)
      }
    })
    runtime.refreshStructuredConversationTabTitle('workspace-1', 'session-1')
    expect(events.at(-1)?.snapshotVersion).toBeGreaterThan(before.snapshotVersion)
    expect(events.at(-1)?.tabs[0]?.title).toBe('auth/login')
    name = undefined
    runtime.refreshStructuredConversationTabTitle('workspace-1', 'session-1')
    expect(events.at(-1)?.tabs[0]?.title).toBe('Claude Chat')
    unsubscribe()
  })
  it('skips every heavy recovery step when no durable session store exists', async () => {
    const runtime = new OrcaRuntimeService()
    const refresh = vi.fn(async () => new Set<string>())
    const ensureHost = vi.fn(async () => undefined)
    const reconcileRestartLeases = vi.fn(async () => undefined)
    const internal = runtime as unknown as {
      hasPersistedStructuredAgentSessionStore(): boolean
      refreshMobileSessionPtyRecords(): Promise<Set<string> | null>
      ensureStructuredAgentSessionHost(): Promise<void>
    }
    internal.hasPersistedStructuredAgentSessionStore = () => false
    internal.refreshMobileSessionPtyRecords = refresh
    internal.ensureStructuredAgentSessionHost = ensureHost
    setStructuredAgentSessionHost({ reconcileRestartLeases } as never)

    await runtime.prepareStructuredAgentSessionStartupRestoration()

    expect(ensureHost).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
    expect(reconcileRestartLeases).not.toHaveBeenCalled()
  })

  it('keeps historical journal parsing outside the terminal-safety fence', async () => {
    const runtime = new OrcaRuntimeService()
    const refresh = vi.fn(async () => new Set<string>())
    const ensureHost = vi.fn(async () => undefined)
    const reconcileRestartLeases = vi.fn(async () => undefined)
    const restoreSavedStatuses = vi.fn(async () => undefined)
    const internal = runtime as unknown as {
      hasPersistedStructuredAgentSessionStore(): boolean
      refreshMobileSessionPtyRecords(): Promise<Set<string> | null>
      ensureStructuredAgentSessionHost(): Promise<void>
    }
    internal.hasPersistedStructuredAgentSessionStore = () => true
    internal.refreshMobileSessionPtyRecords = refresh
    internal.ensureStructuredAgentSessionHost = ensureHost
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the startup restore calls only the host members this stub defines.
    setStructuredAgentSessionHost({ reconcileRestartLeases, restoreSavedStatuses } as never)

    await runtime.prepareStructuredAgentSessionStartupRestoration()

    expect(ensureHost).toHaveBeenCalledOnce()
    expect(refresh).toHaveBeenCalledOnce()
    expect(reconcileRestartLeases).toHaveBeenCalledOnce()
    expect(restoreSavedStatuses).not.toHaveBeenCalled()
  })

  it('loads records, inventories PTYs, restores ownership, then projects tabs exactly once', async () => {
    const runtime = new OrcaRuntimeService()
    const hydrate = vi.fn()
    const refresh = vi.fn(async () => new Set<string>())
    const ensureHost = vi.fn(async () => undefined)
    const reconcileRestartLeases = vi.fn(async () => undefined)
    const restoreSavedStatuses = vi.fn(async () => undefined)
    const internal = runtime as unknown as {
      hasPersistedStructuredAgentSessionStore(): boolean
      getKnownWorkspaceSessionWorktreeIds(): Set<string>
      hydrateHeadlessMobileSessionTabsFromWorkspaceSession(
        worktreeId?: string,
        options?: { allowAttachedWindow?: boolean; onlyRuntimeOwnedTerminals?: boolean }
      ): Set<string>
      refreshMobileSessionPtyRecords(): Promise<Set<string> | null>
      ensureStructuredAgentSessionHost(): Promise<void>
    }
    internal.hasPersistedStructuredAgentSessionStore = () => true
    internal.getKnownWorkspaceSessionWorktreeIds = () => new Set(['workspace-1'])
    internal.hydrateHeadlessMobileSessionTabsFromWorkspaceSession = hydrate
    internal.refreshMobileSessionPtyRecords = refresh
    internal.ensureStructuredAgentSessionHost = ensureHost
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the startup restore calls only the host members this stub defines.
    setStructuredAgentSessionHost({
      reconcileRestartLeases,
      restoreSavedStatuses,
      listSessionTabs: () => []
    } as never)

    const first = runtime.restoreStructuredAgentSessionTabs()
    const second = runtime.restoreStructuredAgentSessionTabs()
    expect(second).toBe(first)
    await Promise.all([first, second])

    expect(hydrate).toHaveBeenCalledWith('workspace-1', {
      allowAttachedWindow: true,
      onlyRuntimeOwnedTerminals: true
    })
    expect(hydrate).toHaveBeenCalledWith()
    expect(refresh).toHaveBeenCalledOnce()
    expect(reconcileRestartLeases).toHaveBeenCalledOnce()
    expect(restoreSavedStatuses).toHaveBeenCalledOnce()
    expect(ensureHost).toHaveBeenCalledOnce()
    expect(ensureHost.mock.invocationCallOrder[0]).toBeLessThan(
      refresh.mock.invocationCallOrder[0] ?? Infinity
    )
    expect(refresh.mock.invocationCallOrder[0]).toBeLessThan(
      reconcileRestartLeases.mock.invocationCallOrder[0] ?? Infinity
    )
    expect(reconcileRestartLeases.mock.invocationCallOrder[0]).toBeLessThan(
      restoreSavedStatuses.mock.invocationCallOrder[0] ?? Infinity
    )
    expect(restoreSavedStatuses.mock.invocationCallOrder[0]).toBeLessThan(
      hydrate.mock.invocationCallOrder[0] ?? Infinity
    )
  })

  it('prefers the durable visible-session index after a legacy profile drops agent tabs', async () => {
    const runtime = new OrcaRuntimeService()
    const restoreSavedStatuses = vi.fn(async () => undefined)
    const listSessionTabs = vi.fn(() => [])
    const internal = runtime as unknown as {
      store: { getWorkspaceSession: () => unknown }
      hasPersistedStructuredAgentSessionStore(): boolean
      getKnownWorkspaceSessionWorktreeIds(): Set<string>
      hydrateHeadlessMobileSessionTabsFromWorkspaceSession(): Set<string>
      refreshMobileSessionPtyRecords(): Promise<Set<string> | null>
      ensureStructuredAgentSessionHost(): Promise<void>
    }
    internal.store = {
      getWorkspaceSession: () => ({
        activeRepoId: null,
        activeWorktreeId: 'workspace-1',
        activeTabId: null,
        tabsByWorktree: {},
        terminalLayoutsByTabId: {},
        unifiedTabs: { 'workspace-1': [] }
      })
    }
    internal.hasPersistedStructuredAgentSessionStore = () => true
    internal.getKnownWorkspaceSessionWorktreeIds = () => new Set()
    internal.hydrateHeadlessMobileSessionTabsFromWorkspaceSession = () => new Set()
    internal.refreshMobileSessionPtyRecords = async () => new Set()
    internal.ensureStructuredAgentSessionHost = async () => undefined
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the startup restore calls only the host members this stub defines.
    setStructuredAgentSessionHost({
      reconcileRestartLeases: async () => undefined,
      getPersistedVisibleSessionTabIndex: () => ({
        present: true,
        sessionIds: ['session-survives-rollback']
      }),
      restoreSavedStatuses,
      listSessionTabs
    } as never)

    await runtime.restoreStructuredAgentSessionTabs()

    expect(restoreSavedStatuses).toHaveBeenCalledWith(['session-survives-rollback'], [])
    // Listed from saved records, not from whatever the restore opened.
    expect(listSessionTabs).toHaveBeenCalledWith(['session-survives-rollback'])
  })

  it('treats an empty durable visible-session index as authoritative', async () => {
    const runtime = new OrcaRuntimeService()
    const restoreSavedStatuses = vi.fn(async () => undefined)
    const internal = runtime as unknown as {
      store: { getWorkspaceSession: () => unknown }
      hasPersistedStructuredAgentSessionStore(): boolean
      getKnownWorkspaceSessionWorktreeIds(): Set<string>
      hydrateHeadlessMobileSessionTabsFromWorkspaceSession(): Set<string>
      refreshMobileSessionPtyRecords(): Promise<Set<string> | null>
      ensureStructuredAgentSessionHost(): Promise<void>
    }
    internal.store = {
      getWorkspaceSession: () => ({
        activeRepoId: null,
        activeWorktreeId: 'workspace-1',
        activeTabId: 'agent-session:closed-session',
        tabsByWorktree: {},
        terminalLayoutsByTabId: {},
        activeTabIdByWorktree: { 'workspace-1': 'agent-session:closed-session' },
        unifiedTabs: {
          'workspace-1': [
            {
              id: 'agent-session:closed-session',
              entityId: 'closed-session',
              groupId: 'group-1',
              worktreeId: 'workspace-1',
              contentType: 'agent-session',
              label: 'Codex Chat',
              customLabel: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        }
      })
    }
    internal.hasPersistedStructuredAgentSessionStore = () => true
    internal.getKnownWorkspaceSessionWorktreeIds = () => new Set()
    internal.hydrateHeadlessMobileSessionTabsFromWorkspaceSession = () => new Set()
    internal.refreshMobileSessionPtyRecords = async () => new Set()
    internal.ensureStructuredAgentSessionHost = async () => undefined
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the startup restore calls only the host members this stub defines.
    setStructuredAgentSessionHost({
      reconcileRestartLeases: async () => undefined,
      getPersistedVisibleSessionTabIndex: () => ({ present: true, sessionIds: [] }),
      restoreSavedStatuses,
      listSessionTabs: () => []
    } as never)

    await runtime.restoreStructuredAgentSessionTabs()

    expect(restoreSavedStatuses).toHaveBeenCalledWith([], [])
  })

  it('normalizes a restored tab id and removes it when closed', async () => {
    const runtime = new OrcaRuntimeService()
    const closeSessionTab = vi.fn(async () => undefined)
    const closeStructuredSession = vi.fn(async () => {
      const snapshot = await runtime.listMobileSessionTabs('id:workspace-1')
      expect(snapshot.tabs.some((tab) => tab.type === 'agent-session')).toBe(false)
    })
    const setSessionTabVisibility = vi.fn(async () => undefined)
    runtime.setNotifier({ closeSessionTab } as never)
    const internal = runtime as unknown as {
      hasPersistedStructuredAgentSessionStore(): boolean
      getKnownWorkspaceSessionWorktreeIds(): Set<string>
      hydrateHeadlessMobileSessionTabsFromWorkspaceSession(): Set<string>
      refreshMobileSessionPtyRecords(): Promise<Set<string> | null>
      ensureStructuredAgentSessionHost(): Promise<void>
    }
    internal.hasPersistedStructuredAgentSessionStore = () => true
    internal.getKnownWorkspaceSessionWorktreeIds = () => new Set()
    internal.hydrateHeadlessMobileSessionTabsFromWorkspaceSession = () => new Set()
    internal.refreshMobileSessionPtyRecords = async () => new Set()
    internal.ensureStructuredAgentSessionHost = async () => undefined
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the startup restore calls only the host members this stub defines.
    setStructuredAgentSessionHost({
      reconcileRestartLeases: async () => undefined,
      restoreSavedStatuses: async () => undefined,
      close: closeStructuredSession,
      setSessionTabVisibility,
      listSessionTabs: () => [
        {
          sessionId: 'agent-session:agent-session:restored-session',
          workspaceId: 'workspace-1',
          agent: 'codex'
        }
      ]
    } as never)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: 'workspace-1',
          publicationEpoch: 'renderer-restored',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: 'terminal-tab::leaf-1',
          activeTabType: 'terminal',
          tabGroups: [{ id: 'group-1', activeTabId: 'terminal-tab', tabOrder: ['terminal-tab'] }],
          tabs: [
            {
              type: 'terminal',
              id: 'terminal-tab::leaf-1',
              parentTabId: 'terminal-tab',
              leafId: 'leaf-1',
              title: 'Terminal',
              isActive: true
            },
            {
              type: 'terminal',
              id: 'terminal-tab::leaf-2',
              parentTabId: 'terminal-tab',
              leafId: 'leaf-2',
              title: 'Terminal',
              isActive: false
            }
          ]
        }
      ]
    })

    await runtime.restoreStructuredAgentSessionTabs()

    const restored = await runtime.listMobileSessionTabs('id:workspace-1')
    expect(restored.tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'terminal',
          id: 'terminal-tab::leaf-1'
        }),
        expect.objectContaining({
          type: 'terminal',
          id: 'terminal-tab::leaf-2'
        }),
        expect.objectContaining({
          type: 'agent-session',
          id: 'agent-session:restored-session',
          sessionId: 'restored-session'
        })
      ])
    )
    expect(restored.tabs).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent-session',
          id: 'agent-session:agent-session:restored-session'
        })
      ])
    )
    expect(restored.tabGroups?.[0]?.tabOrder).toEqual([
      'terminal-tab',
      'agent-session:restored-session'
    ])

    await runtime.closeMobileSessionTab('id:workspace-1', 'agent-session:restored-session', {
      reason: 'user'
    })

    expect(closeSessionTab).toHaveBeenCalledWith('agent-session:restored-session', 'workspace-1')
    // The user closed this chat, so a turn the close cuts short is their cancellation.
    expect(closeStructuredSession).toHaveBeenCalledWith('restored-session', 'user-close')
    expect(setSessionTabVisibility).toHaveBeenCalledWith('restored-session', false)
    expect(setSessionTabVisibility.mock.invocationCallOrder[0]).toBeLessThan(
      closeStructuredSession.mock.invocationCallOrder[0]!
    )

    const closed = await runtime.listMobileSessionTabs('id:workspace-1')
    expect(closed.tabs.map((tab) => tab.id)).toEqual([
      'terminal-tab::leaf-1',
      'terminal-tab::leaf-2'
    ])
    expect(closed.tabGroups?.[0]?.tabOrder).toEqual(['terminal-tab'])
  })

  it('publishes restored Claude tabs with the Claude title', async () => {
    const runtime = new OrcaRuntimeService()
    const project = vi.spyOn(runtime, 'projectStructuredAgentSessionTab')
    const internal = runtime as unknown as {
      hasPersistedStructuredAgentSessionStore(): boolean
      getKnownWorkspaceSessionWorktreeIds(): Set<string>
      hydrateHeadlessMobileSessionTabsFromWorkspaceSession(): Set<string>
      refreshMobileSessionPtyRecords(): Promise<Set<string> | null>
      ensureStructuredAgentSessionHost(): Promise<void>
    }
    internal.hasPersistedStructuredAgentSessionStore = () => true
    internal.getKnownWorkspaceSessionWorktreeIds = () => new Set()
    internal.hydrateHeadlessMobileSessionTabsFromWorkspaceSession = () => new Set()
    internal.refreshMobileSessionPtyRecords = async () => new Set()
    internal.ensureStructuredAgentSessionHost = async () => undefined
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the startup restore calls only the host members this stub defines.
    setStructuredAgentSessionHost({
      reconcileRestartLeases: async () => undefined,
      restoreSavedStatuses: async () => undefined,
      listSessionTabs: () => [
        {
          sessionId: 'agent-session:agent-session:restored-claude',
          workspaceId: 'workspace-1',
          agent: 'claude'
        }
      ]
    } as never)

    await runtime.restoreStructuredAgentSessionTabs()

    expect(project).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sessionId: 'restored-claude',
      agent: 'claude',
      activate: false,
      notify: false
    })

    const restored = await runtime.listMobileSessionTabs('id:workspace-1')
    expect(restored.tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent-session',
          id: 'agent-session:restored-claude',
          title: 'Claude Chat',
          agent: 'claude'
        })
      ])
    )
  })

  // The /clear commit moved the tab in the store already, so replacing it only projects.
  it('replaces a cleared conversation tab without a store write', async () => {
    const runtime = new OrcaRuntimeService()
    const setSessionTabVisibility = vi.fn(async () => undefined)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: replacing a tab reaches the host only through setSessionTabVisibility, which must stay uncalled.
    setStructuredAgentSessionHost({ setSessionTabVisibility } as never)

    runtime.replaceStructuredAgentSessionTab({
      sourceSessionId: 'cleared-session',
      sessionId: 'replacement-session',
      workspaceId: 'workspace-1',
      agent: 'codex'
    })

    const snapshot = await runtime.listMobileSessionTabs('id:workspace-1')
    expect(snapshot.tabs).toEqual([
      expect.objectContaining({
        id: 'agent-session:replacement-session',
        replacesSessionId: 'cleared-session'
      })
    ])
    expect(setSessionTabVisibility).not.toHaveBeenCalled()
  })

  it('commits the host close when the renderer already removed the structured tab', async () => {
    const runtime = new OrcaRuntimeService()
    runtime.setNotifier({
      closeSessionTab: vi.fn(async () => {
        throw new Error('session_tab_not_found')
      })
    } as never)
    await runtime.publishStructuredAgentSessionTab({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      agent: 'codex',
      activate: true
    })

    await runtime.closeMobileSessionTab('id:workspace-1', 'agent-session:session-1', {
      reason: 'user'
    })

    const snapshot = await runtime.listMobileSessionTabs('id:workspace-1')
    expect(snapshot.tabs).toEqual([])
  })
})
