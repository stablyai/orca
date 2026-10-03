import { afterEach, describe, expect, it, vi } from 'vitest'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { OrcaRuntimeService } from './orca-runtime'

afterEach(() => setStructuredAgentSessionHost(null))

/** The host members startup restoration reaches, beyond the seed and settle every test gets. */
type StartupHostMembers = Partial<
  Pick<
    StructuredAgentSessionHost,
    | 'reconcileRestartLeases'
    | 'restoreReadableSessions'
    | 'listSessionTabs'
    | 'getPersistedVisibleSessionTabIndex'
    | 'setSessionTabVisibility'
    | 'close'
  >
>

/** A host offering the startup step's seed and settle, plus the members a test drives. */
function installStartupHost(members: StartupHostMembers): void {
  const host = {
    catchUpMissingStatuses: async () => undefined,
    restoreListedFromPerChatFiles: async () => undefined,
    seedStoredStatuses: (ids: readonly string[]) => [...ids],
    settleOwedSessions: async () => undefined,
    ...members
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: startup restoration reaches only the members each test supplies.
  setStructuredAgentSessionHost(host as unknown as StructuredAgentSessionHost)
}

describe('structured session cold restoration', () => {
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
    installStartupHost({
      reconcileRestartLeases
    })

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
    const restoreReadableSessions = vi.fn(async () => undefined)
    const internal = runtime as unknown as {
      hasPersistedStructuredAgentSessionStore(): boolean
      refreshMobileSessionPtyRecords(): Promise<Set<string> | null>
      ensureStructuredAgentSessionHost(): Promise<void>
    }
    internal.hasPersistedStructuredAgentSessionStore = () => true
    internal.refreshMobileSessionPtyRecords = refresh
    internal.ensureStructuredAgentSessionHost = ensureHost
    installStartupHost({
      reconcileRestartLeases,
      restoreReadableSessions
    })

    await runtime.prepareStructuredAgentSessionStartupRestoration()

    expect(ensureHost).toHaveBeenCalledOnce()
    expect(refresh).toHaveBeenCalledOnce()
    expect(reconcileRestartLeases).toHaveBeenCalledOnce()
    expect(restoreReadableSessions).not.toHaveBeenCalled()
  })

  it('loads records, then restores ownership and inventories PTYs, projects tabs, then restores history, once', async () => {
    const runtime = new OrcaRuntimeService()
    const hydrate = vi.fn()
    const refresh = vi.fn(async () => new Set<string>())
    const ensureHost = vi.fn(async () => undefined)
    const reconcileRestartLeases = vi.fn(async () => undefined)
    const restoreReadableSessions = vi.fn(async () => undefined)
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
    installStartupHost({
      reconcileRestartLeases,
      restoreReadableSessions,
      listSessionTabs: () => []
    })

    const first = runtime.restoreStructuredAgentSessionTabs()
    const second = runtime.restoreStructuredAgentSessionTabs()
    expect(second).toBe(first)
    await Promise.all([first, second])
    // The history pass is owed, not started: the caller that answers with the list starts it.
    expect(restoreReadableSessions).not.toHaveBeenCalled()
    runtime.startStructuredAgentSessionHistoryRestore()
    runtime.startStructuredAgentSessionHistoryRestore()
    expect(restoreReadableSessions).not.toHaveBeenCalled()
    await new Promise((resolve) => setImmediate(resolve))

    expect(hydrate).toHaveBeenCalledWith('workspace-1', {
      allowAttachedWindow: true,
      onlyRuntimeOwnedTerminals: true
    })
    expect(hydrate).toHaveBeenCalledWith()
    expect(refresh).toHaveBeenCalledOnce()
    expect(reconcileRestartLeases).toHaveBeenCalledOnce()
    expect(restoreReadableSessions).toHaveBeenCalledOnce()
    expect(ensureHost).toHaveBeenCalledOnce()
    // The lease check probes processes, not terminals, so it does not wait for the PTY inventory.
    expect(ensureHost.mock.invocationCallOrder[0]).toBeLessThan(
      refresh.mock.invocationCallOrder[0] ?? Infinity
    )
    expect(ensureHost.mock.invocationCallOrder[0]).toBeLessThan(
      reconcileRestartLeases.mock.invocationCallOrder[0] ?? Infinity
    )
    expect(reconcileRestartLeases.mock.invocationCallOrder[0]).toBeLessThan(
      restoreReadableSessions.mock.invocationCallOrder[0] ?? Infinity
    )
    // Tabs are projected first; history opens after, so no chat's history holds the list.
    expect(hydrate.mock.invocationCallOrder[0]).toBeLessThan(
      restoreReadableSessions.mock.invocationCallOrder[0] ?? Infinity
    )
  })

  it('prefers the durable visible-session index after a legacy profile drops agent tabs', async () => {
    const runtime = new OrcaRuntimeService()
    const restoreReadableSessions = vi.fn(async () => undefined)
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
    installStartupHost({
      reconcileRestartLeases: async () => undefined,
      getPersistedVisibleSessionTabIndex: () => ({
        present: true,
        sessionIds: ['session-survives-rollback']
      }),
      restoreReadableSessions,
      listSessionTabs: () => []
    })

    await runtime.restoreStructuredAgentSessionTabs()
    runtime.startStructuredAgentSessionHistoryRestore()

    await vi.waitFor(() =>
      expect(restoreReadableSessions).toHaveBeenCalledWith(['session-survives-rollback'])
    )
  })

  it('treats an empty durable visible-session index as authoritative', async () => {
    const runtime = new OrcaRuntimeService()
    const restoreReadableSessions = vi.fn(async () => undefined)
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
    installStartupHost({
      reconcileRestartLeases: async () => undefined,
      getPersistedVisibleSessionTabIndex: () => ({ present: true, sessionIds: [] }),
      restoreReadableSessions,
      listSessionTabs: () => []
    })

    await runtime.restoreStructuredAgentSessionTabs()
    runtime.startStructuredAgentSessionHistoryRestore()

    await vi.waitFor(() => expect(restoreReadableSessions).toHaveBeenCalledWith([]))
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
    installStartupHost({
      reconcileRestartLeases: async () => undefined,
      restoreReadableSessions: async () => undefined,
      close: closeStructuredSession,
      setSessionTabVisibility,
      listSessionTabs: () => [
        {
          sessionId: 'agent-session:agent-session:restored-session',
          workspaceId: 'workspace-1',
          agent: 'codex'
        }
      ]
    })
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
    installStartupHost({
      reconcileRestartLeases: async () => undefined,
      restoreReadableSessions: async () => undefined,
      listSessionTabs: () => [
        {
          sessionId: 'agent-session:agent-session:restored-claude',
          workspaceId: 'workspace-1',
          agent: 'claude'
        }
      ]
    })

    await runtime.restoreStructuredAgentSessionTabs()

    expect(project).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sessionId: 'restored-claude',
      agent: 'claude',
      activate: false,
      notify: false,
      // Derived once by the restore for every tab it projects.
      replacements: []
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
