import { afterEach, describe, expect, it, vi } from 'vitest'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { OrcaRuntimeService } from './orca-runtime'

afterEach(() => setStructuredAgentSessionHost(null))

type RestoreInternals = {
  store: { getWorkspaceSession: () => unknown }
  hasPersistedStructuredAgentSessionStore(): boolean
  getKnownWorkspaceSessionWorktreeIds(): Set<string>
  hydrateHeadlessMobileSessionTabsFromWorkspaceSession(
    worktreeId?: string,
    options?: { allowAttachedWindow?: boolean; onlyRuntimeOwnedTerminals?: boolean }
  ): Set<string>
  refreshMobileSessionPtyRecords(): Promise<Set<string> | null>
  ensureStructuredAgentSessionHost(): Promise<void>
  storeMobileSessionSnapshot(worktreeId: string, snapshot: unknown): unknown
}

function savedSessionWithChat(sessionId: string) {
  return {
    activeRepoId: null,
    activeWorktreeId: 'workspace-1',
    activeTabId: `agent-session:${sessionId}`,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    activeTabIdByWorktree: { 'workspace-1': `agent-session:${sessionId}` },
    unifiedTabs: {
      'workspace-1': [
        {
          id: `agent-session:${sessionId}`,
          entityId: sessionId,
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
  }
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
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the code under test reads only the host members stubbed here.
    setStructuredAgentSessionHost({ reconcileRestartLeases } as never)

    await runtime.prepareStructuredAgentSessionStartupRestoration()

    expect(ensureHost).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
    expect(reconcileRestartLeases).not.toHaveBeenCalled()
  })

  it('kicks the startup pass without waiting on it, then reconciles once', async () => {
    const runtime = new OrcaRuntimeService()
    const refresh = vi.fn(async () => new Set<string>())
    const ensureHost = vi.fn(async () => undefined)
    const reconcileRestartLeases = vi.fn(async () => undefined)
    const restoreStartupSessions = vi.fn(() => new Promise<void>(() => undefined))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these members exist on the runtime; they are protected, not absent.
    const internal = runtime as unknown as RestoreInternals
    internal.hasPersistedStructuredAgentSessionStore = () => true
    internal.refreshMobileSessionPtyRecords = refresh
    internal.ensureStructuredAgentSessionHost = ensureHost
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the code under test reads only the host members stubbed here.
    setStructuredAgentSessionHost({ reconcileRestartLeases, restoreStartupSessions } as never)

    await runtime.prepareStructuredAgentSessionStartupRestoration()
    await runtime.prepareStructuredAgentSessionStartupRestoration()

    expect(ensureHost).toHaveBeenCalledOnce()
    expect(refresh).toHaveBeenCalledOnce()
    expect(reconcileRestartLeases).toHaveBeenCalledOnce()
    expect(restoreStartupSessions).toHaveBeenCalledOnce()
    expect(ensureHost.mock.invocationCallOrder[0]).toBeLessThan(
      restoreStartupSessions.mock.invocationCallOrder[0] ?? Infinity
    )
  })

  it('answers the tab restore from the index while reconcile and the startup pass hang', async () => {
    const runtime = new OrcaRuntimeService()
    const hydrate = vi.fn()
    const reconcileRestartLeases = vi.fn(() => new Promise<void>(() => undefined))
    const restoreStartupSessions = vi.fn(() => new Promise<void>(() => undefined))
    const setSessionTabVisibility = vi.fn(async () => undefined)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these members exist on the runtime; they are protected, not absent.
    const internal = runtime as unknown as RestoreInternals
    internal.hasPersistedStructuredAgentSessionStore = () => true
    internal.getKnownWorkspaceSessionWorktreeIds = () => new Set(['workspace-1'])
    internal.hydrateHeadlessMobileSessionTabsFromWorkspaceSession = hydrate
    internal.refreshMobileSessionPtyRecords = async () => new Set()
    internal.ensureStructuredAgentSessionHost = async () => undefined
    const store = vi.spyOn(internal, 'storeMobileSessionSnapshot')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the code under test reads only the host members stubbed here.
    setStructuredAgentSessionHost({
      reconcileRestartLeases,
      restoreStartupSessions,
      setSessionTabVisibility,
      getPersistedVisibleSessionTabIndex: () => ({ present: true, sessionIds: ['a', 'b', 'c'] }),
      listPersistedSessionTabs: (ids: readonly string[]) =>
        ids.map((sessionId) => ({
          sessionId,
          workspaceId: sessionId === 'c' ? 'workspace-2' : 'workspace-1',
          agent: 'codex'
        }))
    } as never)

    const first = runtime.restoreStructuredAgentSessionTabs()
    const second = runtime.restoreStructuredAgentSessionTabs()
    expect(second).toBe(first)
    await first

    expect(hydrate).toHaveBeenCalledWith('workspace-1', {
      allowAttachedWindow: true,
      onlyRuntimeOwnedTerminals: true
    })
    expect(restoreStartupSessions).toHaveBeenCalledOnce()
    // One store write per workspace, and no visibility write: the ids came from the index.
    expect(store.mock.calls.map(([workspaceId]) => workspaceId)).toEqual([
      'workspace-1',
      'workspace-2'
    ])
    expect(setSessionTabVisibility).not.toHaveBeenCalled()
    const listed = await runtime.listMobileSessionTabs('id:workspace-1')
    expect(listed.tabs.map((tab) => tab.id)).toEqual(['agent-session:a', 'agent-session:b'])
  })

  it('lists exactly what the durable index holds, including nothing', async () => {
    const runtime = new OrcaRuntimeService()
    const listPersistedSessionTabs = vi.fn(() => [])
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these members exist on the runtime; they are protected, not absent.
    const internal = runtime as unknown as RestoreInternals
    internal.store = { getWorkspaceSession: () => savedSessionWithChat('closed-session') }
    internal.hasPersistedStructuredAgentSessionStore = () => true
    internal.getKnownWorkspaceSessionWorktreeIds = () => new Set()
    internal.hydrateHeadlessMobileSessionTabsFromWorkspaceSession = () => new Set()
    internal.refreshMobileSessionPtyRecords = async () => new Set()
    internal.ensureStructuredAgentSessionHost = async () => undefined
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the code under test reads only the host members stubbed here.
    setStructuredAgentSessionHost({
      reconcileRestartLeases: async () => undefined,
      restoreStartupSessions: async () => undefined,
      getPersistedVisibleSessionTabIndex: () => ({ present: true, sessionIds: [] }),
      listPersistedSessionTabs
    } as never)

    await runtime.restoreStructuredAgentSessionTabs()

    expect(listPersistedSessionTabs).toHaveBeenCalledExactlyOnceWith([])
  })

  it('writes a store without an index every chat its saved session shows', async () => {
    const runtime = new OrcaRuntimeService()
    const index: { present: boolean; sessionIds: string[] } = { present: false, sessionIds: [] }
    const setSessionTabVisibility = vi.fn(async (sessionId: string) => {
      index.present = true
      index.sessionIds.push(sessionId)
    })
    const listPersistedSessionTabs = vi.fn(() => [])
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these members exist on the runtime; they are protected, not absent.
    const internal = runtime as unknown as RestoreInternals
    internal.store = { getWorkspaceSession: () => savedSessionWithChat('legacy-session') }
    internal.hasPersistedStructuredAgentSessionStore = () => true
    internal.getKnownWorkspaceSessionWorktreeIds = () => new Set()
    internal.hydrateHeadlessMobileSessionTabsFromWorkspaceSession = () => new Set()
    internal.refreshMobileSessionPtyRecords = async () => new Set()
    internal.ensureStructuredAgentSessionHost = async () => undefined
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the code under test reads only the host members stubbed here.
    setStructuredAgentSessionHost({
      reconcileRestartLeases: async () => undefined,
      restoreStartupSessions: async () => undefined,
      setSessionTabVisibility,
      getPersistedVisibleSessionTabIndex: () => index,
      listPersistedSessionTabs
    } as never)

    await runtime.restoreStructuredAgentSessionTabs()

    expect(setSessionTabVisibility).toHaveBeenCalledExactlyOnceWith('legacy-session', true)
    expect(listPersistedSessionTabs).toHaveBeenCalledExactlyOnceWith(['legacy-session'])
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
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the code under test reads only the host members stubbed here.
    setStructuredAgentSessionHost({
      reconcileRestartLeases: async () => undefined,
      restoreStartupSessions: async () => undefined,
      close: closeStructuredSession,
      setSessionTabVisibility,
      getPersistedVisibleSessionTabIndex: () => ({ present: true, sessionIds: ['restored'] }),
      listPersistedSessionTabs: () => [
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

    expect(closeSessionTab).toHaveBeenCalledWith(
      'structured-agent-session-restored-session',
      'workspace-1'
    )
    expect(closeStructuredSession).toHaveBeenCalledWith('restored-session')
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
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these members exist on the runtime; they are protected, not absent.
    const internal = runtime as unknown as RestoreInternals
    internal.hasPersistedStructuredAgentSessionStore = () => true
    internal.getKnownWorkspaceSessionWorktreeIds = () => new Set()
    internal.hydrateHeadlessMobileSessionTabsFromWorkspaceSession = () => new Set()
    internal.refreshMobileSessionPtyRecords = async () => new Set()
    internal.ensureStructuredAgentSessionHost = async () => undefined
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the code under test reads only the host members stubbed here.
    setStructuredAgentSessionHost({
      reconcileRestartLeases: async () => undefined,
      restoreStartupSessions: async () => undefined,
      getPersistedVisibleSessionTabIndex: () => ({ present: true, sessionIds: ['restored'] }),
      listPersistedSessionTabs: () => [
        {
          sessionId: 'agent-session:agent-session:restored-claude',
          workspaceId: 'workspace-1',
          agent: 'claude'
        }
      ]
    } as never)

    await runtime.restoreStructuredAgentSessionTabs()

    const restored = await runtime.listMobileSessionTabs('id:workspace-1')
    expect(restored.tabs).toEqual([
      expect.objectContaining({
        type: 'agent-session',
        id: 'agent-session:restored-claude',
        sessionId: 'restored-claude',
        title: 'Claude Chat',
        agent: 'claude',
        isActive: false
      })
    ])
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
