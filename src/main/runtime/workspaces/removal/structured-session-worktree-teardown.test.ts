import { agentSessionConversationView } from '../../../../shared/agent-session/lifecycle/agent-session-conversation-view'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { IPtyProvider } from '../../../providers/pty-provider-contract'
import { ABANDONED_SWEEP_GRACE_MS } from './forced-sweep-settlement'

const hostRef: { current: unknown } = { current: null }

vi.mock('../../../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

const { killAllProcessesForWorktree } = await import('./worktree-teardown')
type TeardownRuntime = NonNullable<Parameters<typeof killAllProcessesForWorktree>[1]['runtime']>
const {
  classifyWorktreeForceDeleteReason,
  isProvenLiveStructuredSessionRemovalError,
  isUnstoppedPtyRemovalError
} = await import('../../../../shared/worktree/removal')
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

/** The structured sweep's own warn — a forced removal can emit a PTY-sweep one onto the same spy. */
function structuredSessionWarning(warn: { mock: { calls: unknown[][] } }): string {
  return (
    warn.mock.calls
      .map((call) => String(call[0]))
      .find((message) => message.includes('agent session')) ?? ''
  )
}

describe('worktree teardown and structured agent sessions', () => {
  beforeEach(() => {
    hostRef.current = null
  })

  it('puts the chat tab back when the removal refuses over the session', async () => {
    // A refused removal preserves the workspace and must restore its chat tabs.
    const host = installHost({
      records: [record('s1', WORKTREE)],
      stuck: new Set(['s1']),
      visible: ['s1']
    })
    await expect(killAllProcessesForWorktree(WORKTREE, destructiveDeps())).rejects.toThrow(
      /still live: 1 agent session \(claude\)/
    )
    expect([...host.visible]).toEqual(['s1'])
  })

  it('leaves the chat tab dropped when a forced removal deletes the workspace anyway', async () => {
    // Force removes the workspace regardless of proof; restoring tabs would persist references to a deleted workspace.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const host = installHost({
      records: [record('s1', WORKTREE)],
      stuck: new Set(['s1']),
      visible: ['s1']
    })
    await killAllProcessesForWorktree(WORKTREE, destructiveDeps({ allowUnverifiedStop: true }))
    expect([...host.visible]).toEqual([])
    warn.mockRestore()
  })

  it('still removes under force when a close does not settle, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const retired: string[] = []
    installHost({ records: [record('s1', WORKTREE)], stuck: new Set(['s1']), visible: ['s1'] })
    const result = await killAllProcessesForWorktree(WORKTREE, {
      ...destructiveDeps({ allowUnverifiedStop: true }),
      runtime: runtimeDouble({
        retireStructuredAgentSessionTabFromSnapshot: (sessionId: string) => {
          retired.push(sessionId)
          return true
        }
      })
    })
    expect(result.structuredStopped).toBeUndefined()
    // The live arm of that record, carrying the verdict the refusal would have shown.
    expect(structuredSessionWarning(warn)).toContain('still live: 1 agent session (claude)')
    expect(retired).toEqual(['s1'])
    warn.mockRestore()
  })

  it('takes the proof when a failed close is re-observed as exited', async () => {
    // Later exit evidence can prove a child gone after close threw or restored its tab.
    const retired: string[] = []
    const runtime: TeardownRuntime = {
      ...presentationRuntime(),
      getPtyLivenessVerdict: () => null,
      stopTerminalsForWorktree: async () => ({ stopped: 0 }),
      retireStructuredAgentSessionTabFromSnapshot: (sessionId: string) => {
        if (!retired.includes(sessionId)) {
          retired.push(sessionId)
        }
        return true
      }
    }
    installHost({ records: [record('s1', WORKTREE)], settledThenThrows: new Set(['s1']) })
    await expect(
      killAllProcessesForWorktree(WORKTREE, { ...destructiveDeps(), runtime })
    ).resolves.toMatchObject({ structuredStopped: 1 })
    // Retired here because the close gave up before its own retirement step, and a chat tab left
    // behind re-attaches a released session pointing at a workspace that is about to be deleted.
    expect(retired).toEqual(['s1'])
  })

  it('leaves a same-id workspace on another execution host alone', async () => {
    // A workspace id is `repoId::path` with no host component, so the local, SSH and paired-runtime
    // copies of one id are DIFFERENT workspaces. Unfenced, deleting the local one closed a chat
    // running on somebody else's machine — a destructive cross-host act, not a spurious refusal.
    const host = installHost({
      records: [record('s1', WORKTREE, { executionHostId: 'ssh:host-a' })]
    })
    await expect(killAllProcessesForWorktree(WORKTREE, destructiveDeps())).resolves.toMatchObject({
      runtimeStopped: 0
    })
    expect(host.closed).toEqual([])
  })

  it('closes only the session on the host the removal resolved to', async () => {
    const host = installHost({
      records: [record('s1', WORKTREE, { executionHostId: 'ssh:host-a' }), record('s2', WORKTREE)]
    })
    await expect(
      killAllProcessesForWorktree(WORKTREE, {
        ...destructiveDeps(),
        resolvedConnectionId: 'host-a'
      })
    ).resolves.toMatchObject({ structuredStopped: 1 })
    expect(host.closed).toEqual(['s1'])
  })

  it('names the unconfirmed sessions too, instead of counting only the live ones', async () => {
    // The PTY sibling may drop everything outside its live list because a fresh inventory PROVED
    // those exited. Nothing proves that here: an `unverifiable` session is unclosed as well, so
    // naming only the live subset told the user "1 agent session" while two were about to go.
    installHost({
      records: [record('s1', WORKTREE), record('s2', WORKTREE, { provider: 'codex' })],
      stuck: new Set(['s1']),
      unverifiable: new Set(['s2'])
    })
    const error = await killAllProcessesForWorktree(WORKTREE, destructiveDeps()).catch(
      (thrown: Error) => thrown.message
    )
    expect(error).toContain(
      'still live: 1 agent session (claude); could not confirm these closed: 1 agent session (codex)'
    )
    // The marker still leads, so the toast keeps showing the stronger of the two warnings.
    expect(isProvenLiveStructuredSessionRemovalError(error as string)).toBe(true)
  })

  it('refuses in agent-session wording when the close outlives the sweep budget', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    try {
      // A structured timeout must not use the PTY sentinel or the desktop misclassifies the refusal (#11960).
      installHost({ records: [record('s1', WORKTREE)], closeGate: new Promise<void>(() => {}) })
      const outcome = killAllProcessesForWorktree(
        WORKTREE,
        destructiveDeps({ timeoutMs: 5 })
      ).catch((thrown: Error) => thrown.message)
      await vi.advanceTimersByTimeAsync(5)
      const error = await outcome
      expect(error).toContain('could not confirm these closed: 1 agent session (claude)')
      expect(isUnstoppedPtyRemovalError(error as string)).toBe(false)
      expect(classifyWorktreeForceDeleteReason(error as string, true)).toBe('running-agent-session')
    } finally {
      vi.useRealTimers()
    }
  })

  it('never wedges Force Delete on a close that will not settle', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      installHost({ records: [record('s1', WORKTREE)], closeGate: new Promise<void>(() => {}) })
      const outcome = killAllProcessesForWorktree(
        WORKTREE,
        destructiveDeps({ allowUnverifiedStop: true, timeoutMs: 5 })
      )
      void outcome.catch(() => undefined)
      await vi.advanceTimersByTimeAsync(5 + ABANDONED_SWEEP_GRACE_MS)
      await expect(outcome).resolves.toMatchObject({ runtimeStopped: 0 })
      const message = structuredSessionWarning(warn)
      expect(message).toContain('could not confirm these closed: 1 agent session (claude)')
      // Timeout proves no live child; forced-removal warnings must say unconfirmed.
      expect(message).not.toContain('still attached')
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })

  it('stops issuing new closes once the budget is spent', async () => {
    // Stop issuing closes at deadline; the uncancellable in-flight close and untouched tail both remain unverified.
    let releaseFirstClose: () => void = () => {}
    const firstClose = new Promise<void>((resolve) => {
      releaseFirstClose = resolve
    })
    const host = installHost({
      records: [record('s1', WORKTREE), record('s2', WORKTREE)],
      closeGates: { s1: firstClose }
    })
    vi.useFakeTimers()
    try {
      const outcome = killAllProcessesForWorktree(
        WORKTREE,
        destructiveDeps({ timeoutMs: 5 })
      ).catch((thrown: Error) => thrown.message)
      await vi.advanceTimersByTimeAsync(5)
      expect(await outcome).toContain('could not confirm these closed: 2 agent sessions (claude)')
      releaseFirstClose()
      await vi.advanceTimersByTimeAsync(0)
      expect(host.closed).toEqual(['s1'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('starts the terminal sweeps while the structured close is still in flight', async () => {
    // Starting PTY sweeps after serial structured closes would spend their shared budget before they can attempt a stop.
    let releaseClose: () => void = () => {}
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve
    })
    installHost({ records: [record('s1', WORKTREE)], closeGate })
    let terminalSweepStarted = false
    const runtime: TeardownRuntime = {
      ...presentationRuntime(),
      getPtyLivenessVerdict: () => null,
      stopTerminalsForWorktree: async () => {
        terminalSweepStarted = true
        return { stopped: 0 }
      }
    }
    const removal = killAllProcessesForWorktree(WORKTREE, { ...destructiveDeps(), runtime })
    await vi.waitFor(() => {
      expect(terminalSweepStarted).toBe(true)
    })
    releaseClose()
    await expect(removal).resolves.toMatchObject({ structuredStopped: 1 })
  })

  it('retires it from the live tab snapshot as well as the durable index', async () => {
    // Durable index hiding alone leaves the live snapshot tab able to reattach this session.
    const retired: string[] = []
    const runtime: TeardownRuntime = {
      ...presentationRuntime(),
      getPtyLivenessVerdict: () => null,
      stopTerminalsForWorktree: async () => ({ stopped: 0 }),
      retireStructuredAgentSessionTabFromSnapshot: (sessionId: string) => {
        if (!retired.includes(sessionId)) {
          retired.push(sessionId)
        }
        return true
      }
    }
    installHost({
      records: [record('s1', WORKTREE)],
      detached: new Set(['s1']),
      visible: ['s1']
    })
    await killAllProcessesForWorktree(WORKTREE, { ...destructiveDeps(), runtime })
    expect(retired).toEqual(['s1'])
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

  it('retires a live snapshot tab when folder cleanup cannot close its child', async () => {
    const retired: string[] = []
    const host = installHost({
      records: [record('s1', WORKTREE)],
      stuck: new Set(['s1']),
      visible: ['s1']
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await killAllProcessesForWorktree(WORKTREE, {
      localProvider,
      includeProviderInventory: false as const,
      includeLocalRegistry: false as const,
      closeStructuredSessions: true,
      runtime: runtimeDouble({
        retireStructuredAgentSessionTabFromSnapshot: (sessionId: string) => {
          retired.push(sessionId)
          return true
        }
      })
    })
    expect([...host.visible]).toEqual([])
    expect(retired).toEqual(['s1'])
    warn.mockRestore()
  })

  it('retires tabs before propagating a best-effort PTY sweep failure', async () => {
    const host = installHost({
      records: [record('s1', WORKTREE)],
      detached: new Set(['s1']),
      visible: ['s1']
    })
    const retired: string[] = []
    const settleModule = await import('./settle-before-deadline')
    const settle = settleModule.settleBeforeDeadline
    const rejection = vi
      .spyOn(settleModule, 'settleBeforeDeadline')
      .mockImplementation((run, fallback, deadline, failClosedError, failClosedOnRunError) => {
        if (fallback === 0) {
          return Promise.reject(new Error('terminal inventory unavailable'))
        }
        return settle(run, fallback, deadline, failClosedError, failClosedOnRunError)
      })
    try {
      await expect(
        killAllProcessesForWorktree(WORKTREE, {
          localProvider,
          includeProviderInventory: true,
          includeLocalRegistry: false,
          closeStructuredSessions: true,
          runtime: runtimeDouble({
            retireStructuredAgentSessionTabFromSnapshot: (sessionId: string) => {
              retired.push(sessionId)
              return true
            }
          })
        })
      ).rejects.toThrow('terminal inventory unavailable')
    } finally {
      rejection.mockRestore()
    }
    expect([...host.visible]).toEqual([])
    expect(retired).toEqual(['s1'])
  })

  it('retires nothing on a reconciliation sweep, which deletes no workspace', async () => {
    // Repair-only callers close nothing and must retain tabs for their surviving workspace.
    const host = installHost({
      records: [record('s1', WORKTREE)],
      detached: new Set(['s1']),
      visible: ['s1']
    })
    await killAllProcessesForWorktree(WORKTREE, {
      localProvider,
      includeProviderInventory: false,
      includeLocalRegistry: false
    })
    expect([...host.visible]).toEqual(['s1'])
  })

  it('leaves a same-id workspace on another host holding its chat tab', async () => {
    // Identical workspace ids on different hosts must not retire one another's tabs.
    const host = installHost({
      records: [record('s1', WORKTREE, { executionHostId: 'ssh:host-a' })],
      detached: new Set(['s1']),
      visible: ['s1']
    })
    await killAllProcessesForWorktree(WORKTREE, destructiveDeps())
    expect([...host.visible]).toEqual(['s1'])
  })
})
