// A chat tab on a host with no window is saved in the host's layout, as a window saves its own:
// opening a chat saves it, closing removes it, and a chat the index restores without one gets one.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { OrcaRuntimeService } from './orca-runtime'
import { withChatTabChanges } from './agent-session-tab-layout'
import { structuredAgentSessionTabId } from '../../shared/structured-agent-session-projection'

const WT = 'repo-1::/tmp/worktree-a'

afterEach(() => setStructuredAgentSessionHost(null))

function createRuntime() {
  const state: { session: WorkspaceSessionState } = {
    session: {
      activeRepoId: 'repo-1',
      activeWorktreeId: WT,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {}
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime reads only these store methods on these paths.
  const runtime = new OrcaRuntimeService(runtimeStore(state) as never)
  return { runtime, state }
}

function runtimeStore(state: { session: WorkspaceSessionState }) {
  return {
    getRepos: () => [],
    getSettings: () => ({}),
    getWorkspaceSession: () => state.session,
    getWorkspaceSessionHostIds: () => ['local' as const],
    setWorkspaceSession: (next: WorkspaceSessionState) => {
      state.session = next
    }
  }
}

/** A chat host with only the members a test's path reads. */
function useChatHost(fake: Record<string, unknown>): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each test supplies every host member its path reads.
  setStructuredAgentSessionHost(fake as never)
}

function chat(sessionId: string) {
  return { sessionId, agent: 'codex' as const, tabId: `structured-agent-session-${sessionId}` }
}

/** A layout saved before tabs carried their execution host. */
function unstamped(session: WorkspaceSessionState): WorkspaceSessionState {
  const unifiedTabs = Object.fromEntries(
    Object.entries(session.unifiedTabs ?? {}).map(([worktreeId, tabs]) => [
      worktreeId,
      tabs.map(({ executionHostId: _host, ...tab }) => tab)
    ])
  )
  return { ...session, unifiedTabs }
}

function savedChatIds(state: { session: WorkspaceSessionState }): string[] {
  return (state.session.unifiedTabs?.[WT] ?? [])
    .filter((tab) => tab.contentType === 'agent-session')
    .map((tab) => tab.entityId)
}

describe('a chat tab on a host with no window', () => {
  it('is saved in the layout once when the chat opens', async () => {
    const { runtime, state } = createRuntime()
    const chat = { workspaceId: WT, sessionId: 'chat-1', agent: 'codex' as const }

    await runtime.publishStructuredAgentSessionTab({ ...chat, activate: true })
    await runtime.publishStructuredAgentSessionTab({ ...chat, activate: true })

    expect(savedChatIds(state)).toEqual(['chat-1'])
  })

  it("saves the tab under the chat's own tab id, the one status and attention address", async () => {
    const { runtime, state } = createRuntime()
    await runtime.publishStructuredAgentSessionTab({
      workspaceId: WT,
      sessionId: 'chat-1',
      agent: 'codex',
      activate: true
    })
    useChatHost({ getSessionTabId: (sessionId: string) => `reserved-${sessionId}` })
    await runtime.publishStructuredAgentSessionTab({
      workspaceId: WT,
      sessionId: 'chat-2',
      agent: 'codex',
      activate: true
    })

    expect(state.session.unifiedTabs?.[WT]?.map((tab) => tab.id)).toEqual([
      'structured-agent-session-chat-1',
      'reserved-chat-2'
    ])
  })

  it('is the tab a window later opening the chat finds, not a second one', async () => {
    const { runtime, state } = createRuntime()
    await runtime.publishStructuredAgentSessionTab({
      workspaceId: WT,
      sessionId: 'chat-1',
      agent: 'codex',
      activate: true
    })

    // A window opening the same chat reuses the tab with this id, content type and entity.
    expect(state.session.unifiedTabs?.[WT]).toEqual([
      expect.objectContaining({
        id: structuredAgentSessionTabId('chat-1'),
        contentType: 'agent-session',
        entityId: 'chat-1'
      })
    ])
  })

  it('leaves the layout when the index hides the chat, on any close path', async () => {
    const { runtime, state } = createRuntime()
    await runtime.publishStructuredAgentSessionTab({
      workspaceId: WT,
      sessionId: 'chat-1',
      agent: 'codex',
      activate: true
    })
    expect(savedChatIds(state)).toEqual(['chat-1'])
    // A fresh runtime lists no chats, as when the close RPC or a worker stop runs before a restore.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime reads only these store methods on these paths.
    const fresh = new OrcaRuntimeService(runtimeStore(state) as never)
    useChatHost({ getPersistedVisibleSessionTabIndex: () => ({ present: true, sessionIds: [] }) })

    fresh.onStructuredSessionTabHidden('chat-1')

    expect(savedChatIds(state)).toEqual([])
  })

  it("closes this host's chat tab in the local partition and leaves every other partition alone", () => {
    const empty: WorkspaceSessionState = {
      activeRepoId: 'repo-1',
      activeWorktreeId: WT,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {}
    }
    const sessions = new Map<string, WorkspaceSessionState>([
      ['local', withChatTabChanges('local', empty, WT, [{ open: chat('chat-1') }])!],
      // A chat that runtime runs, which this host's index never lists.
      [
        'runtime:env-x',
        withChatTabChanges('runtime:env-x', empty, WT, [{ open: chat('chat-x') }])!
      ],
      // An SSH host's chat in a layout saved before tabs were stamped with their host.
      ['ssh:box', unstamped(withChatTabChanges('local', empty, WT, [{ open: chat('chat-ssh') }])!)],
      // A remote server's chat a desktop mirrors, which carries no host stamp.
      [
        'runtime:env-y',
        unstamped(withChatTabChanges('local', empty, WT, [{ open: chat('chat-y') }])!)
      ]
    ])
    const remote = sessions.get('runtime:env-x')
    const ssh = sessions.get('ssh:box')
    const mirrored = sessions.get('runtime:env-y')
    const store = {
      getRepos: () => [],
      getSettings: () => ({}),
      getWorkspaceSessionHostIds: () => [...sessions.keys()],
      getWorkspaceSession: (hostId = 'local') => sessions.get(hostId) ?? null,
      setWorkspaceSession: (next: WorkspaceSessionState, hostId = 'local') => {
        sessions.set(hostId, next)
      }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime reads only these store methods on these paths.
    const runtime = new OrcaRuntimeService(store as never)
    useChatHost({ getPersistedVisibleSessionTabIndex: () => ({ present: true, sessionIds: [] }) })

    runtime.onStructuredSessionTabHidden('chat-1')
    runtime.onStructuredSessionTabHidden('chat-x')
    runtime.onStructuredSessionTabHidden('chat-ssh')
    runtime.onStructuredSessionTabHidden('chat-y')

    expect(sessions.get('local')?.unifiedTabs?.[WT] ?? []).toEqual([])
    expect(sessions.get('runtime:env-x')).toBe(remote)
    expect(sessions.get('ssh:box')).toBe(ssh)
    expect(sessions.get('runtime:env-y')).toBe(mirrored)
  })

  it('keeps its saved tab when a failed close put it back in the index', async () => {
    const { runtime, state } = createRuntime()
    await runtime.publishStructuredAgentSessionTab({
      workspaceId: WT,
      sessionId: 'chat-1',
      agent: 'codex',
      activate: true
    })
    useChatHost({
      getPersistedVisibleSessionTabIndex: () => ({ present: true, sessionIds: ['chat-1'] })
    })

    runtime.onStructuredSessionTabHidden('chat-1')

    expect(savedChatIds(state)).toEqual(['chat-1'])
  })

  it('is saved at startup for a chat the index restores without one', async () => {
    const { runtime, state } = createRuntime()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these are the runtime's own protected members; the test stubs startup's PTY and store probes.
    const internal = runtime as unknown as {
      hasPersistedStructuredAgentSessionStore(): boolean
      refreshMobileSessionPtyRecords(): Promise<Set<string> | null>
      ensureStructuredAgentSessionHost(): Promise<void>
    }
    internal.hasPersistedStructuredAgentSessionStore = () => true
    internal.refreshMobileSessionPtyRecords = async () => new Set()
    internal.ensureStructuredAgentSessionHost = async () => undefined
    useChatHost({
      reconcileRestartLeases: async () => undefined,
      getPersistedVisibleSessionTabIndex: () => ({ present: true, sessionIds: ['chat-1'] }),
      restoreReadableSessions: async () => undefined,
      listSessionTabs: () => [{ sessionId: 'chat-1', workspaceId: WT, agent: 'codex' }]
    })

    await runtime.restoreStructuredAgentSessionTabs()

    expect(savedChatIds(state)).toEqual(['chat-1'])
  })

  it('is left to the window when one saves the layout', async () => {
    const { runtime, state } = createRuntime()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime's own protected member; any non-null value is an attached window.
    const withWindow = runtime as unknown as { getAvailableAuthoritativeWindow(): unknown }
    vi.spyOn(withWindow, 'getAvailableAuthoritativeWindow').mockReturnValue({})

    await runtime.publishStructuredAgentSessionTab({
      workspaceId: WT,
      sessionId: 'chat-1',
      agent: 'codex',
      activate: true
    })

    expect(savedChatIds(state)).toEqual([])
  })
})
