import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { IPtyProvider } from '../providers/pty-provider-contract'
import { ABANDONED_SWEEP_GRACE_MS } from './forced-sweep-settlement'

const hostRef: { current: unknown } = { current: null }

vi.mock('../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

const { killAllProcessesForWorktree } = await import('./worktree-teardown')
type TeardownRuntime = NonNullable<Parameters<typeof killAllProcessesForWorktree>[1]['runtime']>
const {
  classifyWorktreeForceDeleteReason,
  isProvenLiveStructuredSessionRemovalError,
  isUnstoppedPtyRemovalError
} = await import('../../shared/worktree/removal')
const { listStructuredSessionsForWorktree } = await import('./structured-session-worktree-teardown')

const WORKTREE = 'repo_1::/tmp/wt-a'
const OTHER_WORKTREE = 'repo_1::/tmp/wt-b'

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
  /** Death evidence lands during tab-restore transaction, between the close observation and the sweep re-read. */
  exitsDuringTabRestore?: Set<string>
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
      store: {
        listRecords: () => options.records,
        getRecord: () => null,
        getSessionTabId: (sessionId: string) => (visible.has(sessionId) ? `tab-${sessionId}` : null)
      }
    },
    hasSession: (sessionId: string) => held.has(sessionId),
    getPersistedVisibleSessionTabIndex: () => ({ present: true, sessionIds: [...visible] }),
    setSessionTabVisibility: async (sessionId: string, isVisible: boolean) => {
      if (!isVisible) {
        visible.delete(sessionId)
        return
      }
      if (options.exitsDuringTabRestore?.has(sessionId)) {
        recordExit(sessionId)
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
      if (!options.exitsDuringTabRestore?.has(sessionId)) {
        recordExit(sessionId)
      }
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

function runtimeDouble(hooks: TeardownRuntimeStubs): TeardownRuntime {
  return Object.assign(Object.create(null), hooks)
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

  it('finds sessions by workspace, and ignores a sibling worktree', () => {
    installHost({ records: [record('s1', WORKTREE), record('s2', OTHER_WORKTREE)] })
    expect(listStructuredSessionsForWorktree(WORKTREE, {})).toEqual({
      members: [{ sessionId: 's1', agent: 'claude' }],
      live: [{ sessionId: 's1', agent: 'claude' }]
    })
  })

  it('counts a chat with no attached child as a member but never as live', () => {
    // Chats at rest remain workspace members even when no child is attached.
    installHost({ records: [record('s1', WORKTREE)], detached: new Set(['s1']) })
    expect(listStructuredSessionsForWorktree(WORKTREE, {})).toEqual({
      members: [{ sessionId: 's1', agent: 'claude' }],
      live: []
    })
  })

  it('closes a live session on an ordinary removal instead of refusing it', async () => {
    // Structured sessions appear on none of the three PTY surfaces; ordinary removal must close them separately.
    const host = installHost({ records: [record('s1', WORKTREE)] })
    await expect(killAllProcessesForWorktree(WORKTREE, destructiveDeps())).resolves.toMatchObject({
      structuredStopped: 1
    })
    expect(host.closed).toEqual(['s1'])
  })

  it('refuses only when the close does not settle', async () => {
    installHost({ records: [record('s1', WORKTREE)], stuck: new Set(['s1']) })
    await expect(killAllProcessesForWorktree(WORKTREE, destructiveDeps())).rejects.toThrow(
      /still live: 1 agent session \(claude\)/
    )
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

  it('leaves the chat tab dropped for a folder-workspace removal, which never refuses', async () => {
    // Folder removal cannot refuse, so do not restore tabs for the forgotten workspace.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const host = installHost({
      records: [record('s1', WORKTREE)],
      stuck: new Set(['s1']),
      visible: ['s1']
    })
    await killAllProcessesForWorktree(WORKTREE, {
      localProvider,
      includeProviderInventory: false as const,
      includeLocalRegistry: false as const,
      closeStructuredSessions: true
    })
    expect([...host.visible]).toEqual([])
    warn.mockRestore()
  })

  it('drops the chat tab for a session the sweep proves exited after the close gave up', async () => {
    // Exit evidence may arrive during tab rollback; the sweep re-read must undo the restored tab when it proves exit.
    const host = installHost({
      records: [record('s1', WORKTREE)],
      visible: ['s1'],
      exitsDuringTabRestore: new Set(['s1'])
    })
    await expect(killAllProcessesForWorktree(WORKTREE, destructiveDeps())).resolves.toMatchObject({
      structuredStopped: 1
    })
    expect([...host.visible]).toEqual([])
  })

  it('names the force escape hatch in the refusal, like the unstopped-PTY gate', async () => {
    installHost({ records: [record('s1', WORKTREE)], stuck: new Set(['s1']) })
    await expect(killAllProcessesForWorktree(WORKTREE, destructiveDeps())).rejects.toThrow(/force/i)
  })

  it('classifies for the desktop Force Delete button, not just the CLI', async () => {
    // Ordinary desktop deletion already passes force for dirty files; the classifier must separately offer the running-session waiver (#11960).
    installHost({ records: [record('s1', WORKTREE)], stuck: new Set(['s1']) })
    const error = await killAllProcessesForWorktree(WORKTREE, destructiveDeps()).catch(
      (thrown: Error) => thrown.message
    )
    expect(classifyWorktreeForceDeleteReason(error as string, true)).toBe('running-agent-session')
    // Once waived, suppress the button just as for unstopped PTYs.
    expect(classifyWorktreeForceDeleteReason(error as string, true, true)).toBeNull()
  })

  it('keeps session ids out of a message users and agents read', async () => {
    // Session ids lead to mailbox-gating pane keys; CLI/toast text must expose only counts and providers.
    installHost({ records: [record('s1', WORKTREE)], stuck: new Set(['s1']) })
    const error = await killAllProcessesForWorktree(WORKTREE, destructiveDeps()).catch(
      (thrown: Error) => thrown.message
    )
    expect(error).not.toContain('s1')
    expect(error).toContain('1 agent session (claude)')
  })

  it('closes best-effort for a folder-workspace removal, which requires no stop proof', async () => {
    // Folder paths forget shared roots without stop proof; close best-effort without refusing removal.
    const host = installHost({ records: [record('s1', WORKTREE)] })
    await expect(
      killAllProcessesForWorktree(WORKTREE, {
        localProvider,
        includeProviderInventory: false,
        includeLocalRegistry: false,
        closeStructuredSessions: true
      })
    ).resolves.toMatchObject({ structuredStopped: 1 })
    expect(host.closed).toEqual(['s1'])
  })

  it('closes them under force instead of orphaning the child', async () => {
    const host = installHost({ records: [record('s1', WORKTREE), record('s2', WORKTREE)] })
    const result = await killAllProcessesForWorktree(
      WORKTREE,
      destructiveDeps({ allowUnverifiedStop: true })
    )
    expect(host.closed).toEqual(['s1', 's2'])
    expect(result.structuredStopped).toBe(2)
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
    const runtime = {
      stopTerminalsForWorktree: async () => ({ stopped: 0 }),
      retireStructuredAgentSessionTabFromSnapshot: (sessionId: string) => {
        retired.push(sessionId)
        return true
      }
    } as never
    installHost({ records: [record('s1', WORKTREE)], settledThenThrows: new Set(['s1']) })
    await expect(
      killAllProcessesForWorktree(WORKTREE, { ...destructiveDeps(), runtime })
    ).resolves.toMatchObject({ structuredStopped: 1 })
    // Retired here because the close gave up before its own retirement step, and a chat tab left
    // behind re-attaches a released session pointing at a workspace that is about to be deleted.
    expect(retired).toEqual(['s1'])
  })

  it('leaves the best-effort reconciliation paths alone', async () => {
    // Those callers repair state and delete nothing, so a refusal there would wedge a repair.
    installHost({ records: [record('s1', WORKTREE)] })
    await expect(
      killAllProcessesForWorktree(WORKTREE, {
        localProvider,
        includeProviderInventory: false,
        includeLocalRegistry: false
      })
    ).resolves.toMatchObject({ runtimeStopped: 0 })
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

  it('reads an explicit local fence the way the PTY sweeps do', () => {
    // This helper reuses the PTY fence's own type, so the two cannot answer `null` differently:
    // there it means this machine, and it has to mean this machine here. ABSENT is the one
    // deliberate difference — no fence at all for the PTY sweeps, narrowed to local here, because
    // a single-host-id comparison cannot express match-all and closing every host's chats is
    // destructive. Latent today only because `WorktreeTeardownDeps` cannot yet carry the `null`.
    installHost({
      records: [record('s1', WORKTREE, { executionHostId: 'ssh:host-a' }), record('s2', WORKTREE)]
    })
    const local = {
      members: [{ sessionId: 's2', agent: 'claude' }],
      live: [{ sessionId: 's2', agent: 'claude' }]
    }
    expect(listStructuredSessionsForWorktree(WORKTREE, { resolvedConnectionId: null })).toEqual(
      local
    )
    expect(listStructuredSessionsForWorktree(WORKTREE, {})).toEqual(local)
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

  it('names only the sessions that stayed, and every provider still there', async () => {
    installHost({
      records: [
        record('s1', WORKTREE),
        record('s2', WORKTREE, { provider: 'codex' }),
        record('s3', WORKTREE)
      ],
      stuck: new Set(['s2', 's3'])
    })
    const error = await killAllProcessesForWorktree(WORKTREE, destructiveDeps()).catch(
      (thrown: Error) => thrown.message
    )
    expect(error).toContain('still live: 2 agent sessions (claude, codex)')
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

  it('still reports what it closed when a forced removal skips the PTY verdict', async () => {
    // A sweep that fails outright short-circuits the per-PTY verdict — but not the structured
    // close that already ran, so the count has to survive that return or the removal log claims
    // `structured=0` for chats it just ended.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const runtime = {
      stopTerminalsForWorktree: async () => {
        throw new Error('the terminal sweep died')
      }
    } as never
    const host = installHost({ records: [record('s1', WORKTREE)] })
    const result = await killAllProcessesForWorktree(WORKTREE, {
      ...destructiveDeps({ allowUnverifiedStop: true }),
      runtime
    })
    expect(host.closed).toEqual(['s1'])
    expect(result.structuredStopped).toBe(1)
    warn.mockRestore()
  })

  it('separates a close it could not confirm from one it watched stay attached', async () => {
    // `src/shared/worktree/removal.ts` keeps these two apart on purpose: a user waiving "we could
    // not confirm" is making a different decision than one discarding a conversation Orca just saw
    // running. The toast branches on this marker, so flattening them makes one of the two a lie.
    installHost({ records: [record('s1', WORKTREE)], unverifiable: new Set(['s1']) })
    const unconfirmed = await killAllProcessesForWorktree(WORKTREE, destructiveDeps()).catch(
      (thrown: Error) => thrown.message
    )
    expect(unconfirmed).toContain('could not confirm these closed: 1 agent session (claude)')
    expect(isProvenLiveStructuredSessionRemovalError(unconfirmed as string)).toBe(false)

    installHost({ records: [record('s1', WORKTREE)], stuck: new Set(['s1']) })
    const live = await killAllProcessesForWorktree(WORKTREE, destructiveDeps()).catch(
      (thrown: Error) => thrown.message
    )
    expect(isProvenLiveStructuredSessionRemovalError(live as string)).toBe(true)
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

  it('names only the sessions still open when the budget expires mid-close', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    try {
      // Record serial-loop progress before timeout so already-closed children are not reported as unclosed.
      installHost({
        records: [record('s1', WORKTREE), record('s2', WORKTREE, { provider: 'codex' })],
        closeGates: { s2: new Promise<void>(() => {}) }
      })
      const outcome = killAllProcessesForWorktree(
        WORKTREE,
        destructiveDeps({ timeoutMs: 40 })
      ).catch((thrown: Error) => thrown.message)
      await vi.advanceTimersByTimeAsync(40)
      const error = await outcome
      expect(error).toContain('could not confirm these closed: 1 agent session (codex)')
      expect(error).not.toContain('claude')
    } finally {
      vi.useRealTimers()
    }
  })

  it('counts the closes that landed before the budget expired', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    // Preserve completed-close counts in timeout logs.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const slowClose = new Promise<void>((resolve) => {
      setTimeout(resolve, 300)
    })
    try {
      installHost({
        records: [record('s1', WORKTREE), record('s2', WORKTREE, { provider: 'codex' })],
        closeGates: { s2: slowClose }
      })
      const outcome = killAllProcessesForWorktree(
        WORKTREE,
        destructiveDeps({ allowUnverifiedStop: true, timeoutMs: 40 })
      )
      void outcome.catch(() => undefined)
      await vi.advanceTimersByTimeAsync(300)
      const result = await outcome
      expect(result.structuredStopped).toBe(1)
      expect(structuredSessionWarning(warn)).toContain(
        'could not confirm these closed: 1 agent session (codex)'
      )
    } finally {
      try {
        await vi.advanceTimersByTimeAsync(300)
        await slowClose
      } finally {
        warn.mockRestore()
        vi.useRealTimers()
      }
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

  it('leaves the terminals already stopped when it refuses over a stuck session', async () => {
    // PTY sweeps run concurrently to share the deadline: structured refusal can follow already-stopped PTYs.
    // Serializing again would starve terminal stops and let force-delete remove files with open PTY handles.
    let terminalSweeps = 0
    const runtime = {
      stopTerminalsForWorktree: async () => {
        terminalSweeps += 1
        return { stopped: 2 }
      }
    } as never
    installHost({ records: [record('s1', WORKTREE)], stuck: new Set(['s1']) })
    await expect(
      killAllProcessesForWorktree(WORKTREE, { ...destructiveDeps(), runtime })
    ).rejects.toThrow(/still live: 1 agent session \(claude\)/)
    expect(terminalSweeps).toBe(1)
  })

  it('starts the terminal sweeps while the structured close is still in flight', async () => {
    // Starting PTY sweeps after serial structured closes would spend their shared budget before they can attempt a stop.
    let releaseClose: () => void = () => {}
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve
    })
    installHost({ records: [record('s1', WORKTREE)], closeGate })
    let terminalSweepStarted = false
    const runtime = {
      stopTerminalsForWorktree: async () => {
        terminalSweepStarted = true
        return { stopped: 0 }
      }
    } as never
    const removal = killAllProcessesForWorktree(WORKTREE, { ...destructiveDeps(), runtime })
    await vi.waitFor(() => {
      expect(terminalSweepStarted).toBe(true)
    })
    releaseClose()
    await expect(removal).resolves.toMatchObject({ structuredStopped: 1 })
  })

  it('retires the chat tab of a chat that had no child to close', async () => {
    // Chats at rest are absent from the close list; their durable tab index must not resurrect a deleted workspace.
    const host = installHost({
      records: [record('s1', WORKTREE)],
      detached: new Set(['s1']),
      visible: ['s1']
    })
    await expect(killAllProcessesForWorktree(WORKTREE, destructiveDeps())).resolves.toMatchObject({
      runtimeStopped: 0
    })
    expect(host.closed).toEqual([])
    expect([...host.visible]).toEqual([])
  })

  it('retires it from the live tab snapshot as well as the durable index', async () => {
    // Durable index hiding alone leaves the live snapshot tab able to reattach this session.
    const retired: string[] = []
    const runtime = {
      stopTerminalsForWorktree: async () => ({ stopped: 0 }),
      retireStructuredAgentSessionTabFromSnapshot: (sessionId: string) => {
        retired.push(sessionId)
        return true
      }
    } as never
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

  it('retires the chat tab under force, which deletes the workspace anyway', async () => {
    const host = installHost({
      records: [record('s1', WORKTREE)],
      detached: new Set(['s1']),
      visible: ['s1']
    })
    await killAllProcessesForWorktree(WORKTREE, destructiveDeps({ allowUnverifiedStop: true }))
    expect([...host.visible]).toEqual([])
  })

  it('retires the chat tab for a folder-workspace removal too', async () => {
    // Forgetting folder metadata must retire detached tabs even though the shared checkout remains.
    const host = installHost({
      records: [record('s1', WORKTREE)],
      detached: new Set(['s1']),
      visible: ['s1']
    })
    await killAllProcessesForWorktree(WORKTREE, {
      localProvider,
      includeProviderInventory: false as const,
      includeLocalRegistry: false as const,
      closeStructuredSessions: true
    })
    expect([...host.visible]).toEqual([])
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

  it('does not block removal when no structured host is installed', async () => {
    // Reading persisted storage would force-install a host during teardown; an unavailable host proves no child.
    await expect(killAllProcessesForWorktree(WORKTREE, destructiveDeps())).resolves.toMatchObject({
      runtimeStopped: 0
    })
  })
})
