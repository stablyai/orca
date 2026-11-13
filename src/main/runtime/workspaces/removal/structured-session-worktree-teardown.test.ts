import { agentSessionConversationView } from '../../../../shared/agent-session/lifecycle/agent-session-conversation-view'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { IPtyProvider } from '../../../providers/pty/provider-contract'

const hostRef: { current: unknown } = { current: null }

vi.mock('../../../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

const { killAllProcessesForWorktree } = await import('./worktree-teardown')
type TeardownRuntime = NonNullable<Parameters<typeof killAllProcessesForWorktree>[1]['runtime']>
await import('../../../../shared/worktree/removal/removal')
await import('./structured-session-worktree-teardown')

const WORKTREE = 'repo_1::/tmp/wt-a'

function record(
  sessionId: string,
  workspaceId: string,
  options: { provider?: 'claude' | 'codex'; executionHostId?: string } = {}
): AgentSessionRecord {
  return {
    sessionId,
    provider: options.provider ?? 'claude',
    location: {
      executionHostId: options.executionHostId ?? 'local',
      wslDistro: null,
      workspaceId,
      workspaceKind: 'folder'
    },
    lease: {
      sessionId,
      runtimeKind: 'native',
      claimStatus: 'live',
      handoffStage: null,
      runtimeFence: 1,
      deathEvidence: null
    }
  } as unknown as AgentSessionRecord
}

function installHost(options: {
  records: AgentSessionRecord[]
  /** Sessions the host keeps holding through a close, so the post-close observation is `live`. */
  stuck?: Set<string>
  /** Sessions the host drops without death evidence, so the observation is `unverifiable`. */
  unverifiable?: Set<string>
  /** Sessions whose child dies and is recorded dead, but whose close then fails past that point. */
  settledThenThrows?: Set<string>
  /** Blocks every close, to exercise the shared sweep budget without fake timers. */
  closeGate?: Promise<void>
  /** Blocks ONE session's close, so the serial loop can be caught part-way through. */
  closeGates?: Record<string, Promise<void>>
  /** Sessions in the persisted visible-tab index, so a rollback has something to put back. */
  visible?: string[]
  /** Detached chats are ordinary idle-sweep results; they remain workspace members without a live child. */
  detached?: Set<string>
}): { closed: string[]; visible: Set<string> } {
  const held = new Set(
    options.records
      .map((entry) => entry.sessionId)
      .filter((sessionId) => !options.detached?.has(sessionId))
  )
  const closed: string[] = []
  const visible = new Set(options.visible ?? [])
  const recordExit = (sessionId: string): void => {
    const entry = options.records.find((candidate) => candidate.sessionId === sessionId)
    if (entry) {
      entry.lease.claimStatus = 'released'
      entry.lease.deathEvidence = { kind: 'exit-observed', detail: 'closed', observedAt: 1 }
    }
  }
  hostRef.current = {
    deps: {
      logger: { warn: vi.fn() },
      store: {
        listRecords: () => options.records,
        listConversations: () => options.records.map(agentSessionConversationView),
        getConversation: (id: string) => {
          const row = options.records.find((entry) => entry.sessionId === id)
          return row ? agentSessionConversationView(row) : null
        },
        getRecord: () => null,
        getSessionTabId: (sessionId: string) => (visible.has(sessionId) ? `tab-${sessionId}` : null)
      }
    },
    getSessionTabId: (sessionId: string) => (visible.has(sessionId) ? `tab-${sessionId}` : null),
    hasSession: (sessionId: string) => held.has(sessionId),
    getPersistedVisibleSessionTabIndex: () => ({ present: true, sessionIds: [...visible] }),
    setSessionTabVisibility: async (sessionId: string, isVisible: boolean) => {
      if (!isVisible) {
        visible.delete(sessionId)
        return
      }
      visible.add(sessionId)
    },
    close: async (sessionId: string) => {
      closed.push(sessionId)
      await options.closeGate
      await options.closeGates?.[sessionId]
      if (options.stuck?.has(sessionId)) {
        return
      }
      held.delete(sessionId)
      if (options.unverifiable?.has(sessionId)) {
        return
      }
      recordExit(sessionId)
      if (options.settledThenThrows?.has(sessionId)) {
        throw new Error('the event sink could not be flushed')
      }
    }
  }
  // `observeStructuredWorker` reads the record through the same host, so keep them consistent.
  ;(
    hostRef.current as { deps: { store: { getRecord: (id: string) => unknown } } }
  ).deps.store.getRecord = (sessionId: string) =>
    options.records.find((entry) => entry.sessionId === sessionId) ?? null
  return { closed, visible }
}

const localProvider = {
  listProcesses: async () => [],
  shutdown: async () => {}
} as never

function destructiveDeps(extra: { allowUnverifiedStop?: boolean; timeoutMs?: number } = {}) {
  return {
    localProvider,
    requirePhysicalStop: true,
    includeProviderInventory: false as const,
    includeLocalRegistry: false as const,
    ...extra
  }
}

/** Keys are pinned to the real runtime; each stub narrows its own args to what the case drives. */
type TeardownRuntimeStubs = Partial<Record<keyof TeardownRuntime, unknown>>

function presentationRuntime() {
  const retired = new Set<string>()
  const raw = (sessionId: string) =>
    retired.has(sessionId) ? null : { worktreeId: WORKTREE, tabId: `raw-${sessionId}` }
  return {
    captureStructuredAgentSessionPresentation: (sessionId: string) => ({
      raw: raw(sessionId),
      saved: []
    }),
    currentLocalStructuredSessionPresentation: raw,
    removeCapturedStructuredSessionSavedTabs: () => {},
    retireStructuredAgentSessionTabFromSnapshot: (sessionId: string) => {
      retired.add(sessionId)
      return true
    }
  }
}

function runtimeDouble(hooks: TeardownRuntimeStubs): TeardownRuntime {
  return Object.assign(Object.create(null), presentationRuntime(), hooks)
}

function livePtyProvider(): IPtyProvider {
  return Object.assign(Object.create(null), {
    listProcesses: async () => [{ id: 'pty-1' }],
    shutdown: async () => {}
  })
}

describe('worktree teardown and structured agent sessions', () => {
  beforeEach(() => {
    hostRef.current = null
  })

  it('keeps every chat tab when the removal refuses over a session it could not close', async () => {
    // Refusal must preserve both the stuck chat and its detached workspace sibling.
    const host = installHost({
      records: [record('s1', WORKTREE), record('s2', WORKTREE)],
      stuck: new Set(['s1']),
      detached: new Set(['s2']),
      visible: ['s1', 's2']
    })
    await expect(killAllProcessesForWorktree(WORKTREE, destructiveDeps())).rejects.toThrow(
      /still live: 1 agent session \(claude\)/
    )
    expect([...host.visible].sort()).toEqual(['s1', 's2'])
  })

  it('keeps every chat tab when the unstopped-PTY gate refuses the removal', async () => {
    // Retirement must wait for the PTY gate too; it can refuse after the structured sweep succeeds.
    const runtime = runtimeDouble({
      stopTerminalsForWorktree: async (
        _worktreeId: string,
        options: { stopPty: (ptyId: string, stop: () => Promise<boolean>) => Promise<unknown> }
      ) => {
        await options.stopPty('pty-1', async () => false)
        return { stopped: 0 }
      }
    })
    const liveProvider = livePtyProvider()
    const host = installHost({
      records: [record('s1', WORKTREE)],
      detached: new Set(['s1']),
      visible: ['s1']
    })
    await expect(
      killAllProcessesForWorktree(WORKTREE, {
        localProvider: liveProvider,
        requirePhysicalStop: true,
        includeProviderInventory: false,
        includeLocalRegistry: false,
        runtime
      })
    ).rejects.toThrow(/still live: pty-1/)
    expect([...host.visible]).toEqual(['s1'])
  })
})
