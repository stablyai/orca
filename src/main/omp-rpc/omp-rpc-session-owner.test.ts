import { describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionExecutionClaim,
  AgentSessionSurfaceBinding
} from '../../shared/agent-session-host-authority'
import { ClaimedAgentPtyOwnerRegistry } from '../../shared/claimed-agent-pty-owner'
import type {
  OmpRpcClientEvent,
  OmpRpcExit,
  OmpRpcSessionState,
  OmpSessionOwningRpcClient
} from '../../shared/omp-rpc-protocol'
import type { OmpRpcSubagentSubscriptionLevel } from '../../shared/omp-rpc-subagent-protocol'
import { OmpRpcSessionOwner, type OmpRpcOwnerExitVerdict } from './omp-rpc-session-owner'
import { waitForOmpRpcSettle } from './omp-rpc-session-settle-and-exit-proof'

const settledState: OmpRpcSessionState = {
  sessionFile: '/sessions/current.jsonl',
  sessionId: 'session-current',
  isStreaming: false,
  isCompacting: false,
  queuedMessageCount: 0
}

it('fails a silent initial readiness wait at the configured startup deadline', async () => {
  vi.useFakeTimers()
  try {
    const client = fakeClient({
      whenReady: vi.fn<() => ReturnType<OmpSessionOwningRpcClient['whenReady']>>(
        () => new Promise(() => {})
      )
    })
    const owner = new OmpRpcSessionOwner({
      registry: new ClaimedAgentPtyOwnerRegistry(),
      spawnClient: () => client,
      readyDeadlineMs: 10,
      proveRpcExit: async () => ({ status: 'exited' })
    })
    const acquiring = owner.acquire({ claim: claim(), spawnOptions })
    await vi.advanceTimersByTimeAsync(10)

    await expect(acquiring).resolves.toMatchObject({
      status: 'spawn-failed',
      reason: 'OMP RPC initial readiness timed out after 10ms'
    })
    expect(client.dispose).toHaveBeenCalledOnce()
  } finally {
    vi.useRealTimers()
  }
})

const surface: AgentSessionSurfaceBinding = {
  worktreeId: 'worktree',
  tabId: 'tab',
  leafId: '12345678-1234-4234-8234-123456789abc',
  terminalHandle: 'term_handle'
}

function claim(): AgentSessionExecutionClaim {
  return {
    digestVersion: 1,
    keyId: 'omp-session',
    identityDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    worktreeScopeDigest: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    agent: 'omp'
  }
}

function fakeClient(overrides: Partial<OmpSessionOwningRpcClient> = {}): OmpSessionOwningRpcClient {
  const listeners = new Set<(event: OmpRpcClientEvent) => void>()
  return {
    whenReady: vi.fn(async () => ({
      ready: {
        type: 'ready' as const,
        protocolVersion: 1 as const,
        supportedProtocolVersions: [1, 2],
        maxFrameBytes: 1_048_576,
        maxReassembledFrameBytes: 67_108_864
      },
      negotiatedProtocolVersion: 2
    })),
    getCommands: vi.fn(async () => []),
    prompt: vi.fn(async () => ({ agentInvoked: true })),
    steer: vi.fn(async () => ({ agentInvoked: true })),
    followUp: vi.fn(async () => ({ agentInvoked: true })),
    respondExtensionUi: vi.fn(() => true),
    getState: vi.fn(async () => settledState),
    getMessagesPage: vi.fn(async () => ({ messages: [], totalMessages: 0 })),
    fetchHistory: vi.fn(async () => ({
      kind: 'complete' as const,
      messages: [],
      totalMessages: 0
    })),
    setSubagentSubscription: vi.fn(async (level: OmpRpcSubagentSubscriptionLevel) => level),
    switchSession: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    whenExited: vi.fn(async () => ({ code: 0, signal: null })),
    on: vi.fn((listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }),
    dispose: vi.fn(),
    ...overrides
  }
}

const spawnOptions = {
  executablePath: 'omp',
  cwd: '/worktree'
}

function acquiredSession(
  result: Awaited<ReturnType<OmpRpcSessionOwner['acquire']>>
): Extract<typeof result, { status: 'acquired' }> {
  expect(result.status).toBe('acquired')
  if (result.status !== 'acquired') {
    throw new Error(`Expected acquisition, received ${result.status}`)
  }
  return result
}

describe('OMP RPC session ownership', () => {
  it('refuses a non-OMP execution claim without spawning', async () => {
    const spawnClient = vi.fn(() => fakeClient())
    const owner = new OmpRpcSessionOwner({
      registry: new ClaimedAgentPtyOwnerRegistry(),
      spawnClient
    })

    await expect(
      owner.acquire({ claim: { ...claim(), agent: 'codex' }, spawnOptions })
    ).resolves.toEqual({
      status: 'ownership-unknown',
      reason: 'agent_session_ownership_unknown'
    })
    expect(spawnClient).not.toHaveBeenCalled()
  })

  it('keeps spawn error provenance when its message resembles a conflict', async () => {
    const owner = new OmpRpcSessionOwner({
      registry: new ClaimedAgentPtyOwnerRegistry(),
      spawnClient: () => {
        throw new Error('agent_session_conflict')
      }
    })

    await expect(owner.acquire({ claim: claim(), spawnOptions })).resolves.toEqual({
      status: 'spawn-failed',
      reason: 'agent_session_conflict'
    })
  })

  it('refuses to spawn when a PTY owns the claim', async () => {
    const registry = new ClaimedAgentPtyOwnerRegistry()
    await registry.ensure({
      claim: claim(),
      surface,
      spawn: async () => ({ ptyId: 'pty-1' })
    })
    const spawnClient = vi.fn(() => fakeClient())
    const owner = new OmpRpcSessionOwner({ registry, spawnClient })

    await expect(owner.acquire({ claim: claim(), spawnOptions })).resolves.toEqual({
      status: 'conflict',
      reason: 'agent_session_conflict'
    })
    expect(spawnClient).not.toHaveBeenCalled()
  })

  it('refuses a PTY claim while an RPC child owns the session', async () => {
    const registry = new ClaimedAgentPtyOwnerRegistry()
    const owner = new OmpRpcSessionOwner({
      registry,
      spawnClient: () => fakeClient()
    })
    acquiredSession(await owner.acquire({ claim: claim(), spawnOptions }))
    const spawnPty = vi.fn(async () => ({ ptyId: 'pty-1' }))

    await expect(registry.ensure({ claim: claim(), surface, spawn: spawnPty })).rejects.toThrow(
      'agent_session_conflict'
    )
    expect(spawnPty).not.toHaveBeenCalled()
  })

  it('disposes, proves exit, releases, then builds the PTY resume launch', async () => {
    const order: string[] = []
    const client = fakeClient({ dispose: vi.fn(() => order.push('dispose')) })
    const registry = new ClaimedAgentPtyOwnerRegistry()
    const originalRelease = registry.releaseRpc.bind(registry)
    vi.spyOn(registry, 'releaseRpc').mockImplementation((binding) => {
      order.push('release')
      return originalRelease(binding)
    })
    const owner = new OmpRpcSessionOwner({
      registry,
      spawnClient: () => client,
      proveRpcExit: async () => {
        order.push('prove-exit')
        return { status: 'exited' }
      },
      buildResumeLaunch: () => {
        order.push('resume')
        return 'omp --resume /sessions/current.jsonl'
      }
    })
    const session = acquiredSession(await owner.acquire({ claim: claim(), spawnOptions })).session

    await expect(
      owner.handoffToPty({ session, baseCommand: 'omp', shell: 'posix' })
    ).resolves.toMatchObject({
      status: 'exited',
      launchCommand: 'omp --resume /sessions/current.jsonl',
      sessionFile: '/sessions/current.jsonl'
    })
    expect(order).toEqual(['dispose', 'prove-exit', 'release', 'resume'])
  })

  it('retains the claim and refuses resume when exit is unverifiable', async () => {
    // A child that has not exited: the claim must stay held (a late exit
    // frees it — covered separately below).
    const client = fakeClient({ whenExited: vi.fn(() => new Promise<OmpRpcExit>(() => {})) })
    const registry = new ClaimedAgentPtyOwnerRegistry()
    const buildResumeLaunch = vi.fn(() => 'must-not-run')
    const owner = new OmpRpcSessionOwner({
      registry,
      spawnClient: () => client,
      proveRpcExit: async (): Promise<OmpRpcOwnerExitVerdict> => ({
        status: 'unverifiable',
        reason: 'host stopped responding'
      }),
      buildResumeLaunch
    })
    const session = acquiredSession(await owner.acquire({ claim: claim(), spawnOptions })).session

    await expect(
      owner.handoffToPty({ session, baseCommand: 'omp', shell: 'posix' })
    ).resolves.toEqual({
      status: 'unverifiable',
      reason: 'host stopped responding'
    })
    expect(registry.findRpc(claim())).not.toBeNull()
    expect(buildResumeLaunch).not.toHaveBeenCalled()
  })

  // Critical B (cross-lab review, wave 5): handoffToPty used to abort a
  // streaming turn unconditionally — the exact "a mere view toggle silently
  // aborts an in-flight turn" outcome Decision 1/F9 forbid. Default is now
  // never-abort; only an explicit `allowAbort: true` caller may abort.
  it('never aborts a streaming turn by default — waits for it to settle before reading the session path', async () => {
    const order: string[] = []
    const streamingState: OmpRpcSessionState = {
      get sessionFile() {
        order.push('read-stale-path')
        return '/sessions/stale.jsonl'
      },
      sessionId: 'session-current',
      isStreaming: true,
      isCompacting: false,
      queuedMessageCount: 0
    }
    const finalState: OmpRpcSessionState = {
      get sessionFile() {
        order.push('read-path')
        return '/sessions/current.jsonl'
      },
      sessionId: 'session-current',
      isStreaming: false,
      isCompacting: false,
      queuedMessageCount: 0
    }
    const getState = vi
      .fn<() => Promise<OmpRpcSessionState>>()
      .mockResolvedValueOnce(streamingState)
      .mockResolvedValue(finalState)
    const abort = vi.fn(async () => {
      order.push('abort')
    })
    const client = fakeClient({ getState, abort })
    const owner = new OmpRpcSessionOwner({
      registry: new ClaimedAgentPtyOwnerRegistry(),
      spawnClient: () => client,
      waitForSettle: async () => {
        order.push('settle')
        return { status: 'settled' }
      },
      proveRpcExit: async () => ({ status: 'exited' }),
      buildResumeLaunch: () => 'omp --resume /sessions/current.jsonl'
    })
    const session = acquiredSession(await owner.acquire({ claim: claim(), spawnOptions })).session

    await owner.handoffToPty({ session, baseCommand: 'omp', shell: 'posix' })

    expect(order).toEqual(['settle', 'read-path'])
    expect(abort).not.toHaveBeenCalled()
  })

  // XLR-005 (cross-lab review): `waitForSettle` resolving is an observation,
  // not a lease. A prompt accepted between it and the confirming re-read is
  // live work again, and the old code disposed the child anyway on the
  // strength of the stale proof — silently aborting it.
  it('fails closed without disposing when the settle proof goes stale before the confirming read', async () => {
    const streamingAgain: OmpRpcSessionState = {
      sessionFile: '/sessions/current.jsonl',
      sessionId: 'session-current',
      isStreaming: true,
      isCompacting: false,
      queuedMessageCount: 0
    }
    const client = fakeClient({ getState: vi.fn(async () => streamingAgain) })
    const registry = new ClaimedAgentPtyOwnerRegistry()
    const releaseRpc = vi.spyOn(registry, 'releaseRpc')
    const owner = new OmpRpcSessionOwner({
      registry,
      spawnClient: () => client,
      // Reports settled, but the confirming re-read below sees a new turn.
      waitForSettle: async () => ({ status: 'settled' }),
      proveRpcExit: async () => ({ status: 'exited' }),
      buildResumeLaunch: () => 'omp --resume /sessions/current.jsonl'
    })
    const session = acquiredSession(await owner.acquire({ claim: claim(), spawnOptions })).session

    const result = await owner.handoffToPty({ session, baseCommand: 'omp', shell: 'posix' })

    expect(result.status).toBe('unverifiable')
    expect(client.dispose).not.toHaveBeenCalled()
    expect(releaseRpc).not.toHaveBeenCalled()
  })

  it('aborts and settles streaming work before reading the session path when allowAbort is explicitly set', async () => {
    const order: string[] = []
    const streamingState: OmpRpcSessionState = {
      get sessionFile() {
        order.push('read-stale-path')
        return '/sessions/stale.jsonl'
      },
      sessionId: 'session-current',
      isStreaming: true,
      isCompacting: false,
      queuedMessageCount: 0
    }
    const finalState: OmpRpcSessionState = {
      get sessionFile() {
        order.push('read-path')
        return '/sessions/current.jsonl'
      },
      sessionId: 'session-current',
      isStreaming: false,
      isCompacting: false,
      queuedMessageCount: 0
    }
    const getState = vi
      .fn<() => Promise<OmpRpcSessionState>>()
      .mockResolvedValueOnce(streamingState)
      .mockResolvedValue(finalState)
    const client = fakeClient({
      getState,
      abort: vi.fn(async () => {
        order.push('abort')
      })
    })
    const owner = new OmpRpcSessionOwner({
      registry: new ClaimedAgentPtyOwnerRegistry(),
      spawnClient: () => client,
      waitForSettle: async () => {
        order.push('settle')
        return { status: 'settled' }
      },
      proveRpcExit: async () => ({ status: 'exited' }),
      buildResumeLaunch: () => 'omp --resume /sessions/current.jsonl'
    })
    const session = acquiredSession(await owner.acquire({ claim: claim(), spawnOptions })).session

    await owner.handoffToPty({ session, baseCommand: 'omp', shell: 'posix', allowAbort: true })

    expect(order).toEqual(['abort', 'settle', 'read-path'])
  })

  // Critical B: the unmount path (leave Chat view, pane force-close, app
  // quit) must fail closed rather than silently killing live work — a turn
  // that never settles within the bounded wait keeps the claim, and the
  // client is never disposed out from under it.
  it('fails closed without disposing the client when a streaming turn never settles', async () => {
    const streamingState: OmpRpcSessionState = {
      sessionFile: '/sessions/current.jsonl',
      sessionId: 'session-current',
      isStreaming: true,
      isCompacting: false,
      queuedMessageCount: 0
    }
    const client = fakeClient({ getState: vi.fn(async () => streamingState) })
    const owner = new OmpRpcSessionOwner({
      registry: new ClaimedAgentPtyOwnerRegistry(),
      spawnClient: () => client,
      waitForSettle: async () => ({
        status: 'unverifiable',
        cause: 'timeout',
        reason: 'OMP RPC session did not settle before timeout'
      })
    })
    const session = acquiredSession(await owner.acquire({ claim: claim(), spawnOptions })).session

    await expect(
      owner.handoffToPty({ session, baseCommand: 'omp', shell: 'posix' })
    ).resolves.toEqual({
      status: 'unverifiable',
      reason: 'OMP RPC session did not settle before timeout'
    })
    expect(client.dispose).not.toHaveBeenCalled()
    expect(client.abort).not.toHaveBeenCalled()
  })

  it('proves the PTY exited before spawning and switching the RPC child', async () => {
    const order: string[] = []
    const registry = new ClaimedAgentPtyOwnerRegistry()
    await registry.ensure({
      claim: claim(),
      surface,
      spawn: async () => ({ ptyId: 'pty-1' })
    })
    const originalRelease = registry.release.bind(registry)
    vi.spyOn(registry, 'release').mockImplementation((...args) => {
      order.push('release-pty')
      originalRelease(...args)
    })
    const client = fakeClient({
      switchSession: vi.fn(async () => {
        order.push('switch')
      })
    })
    const spawnClient = vi.fn(() => {
      order.push('spawn')
      return client
    })
    const owner = new OmpRpcSessionOwner({
      registry,
      spawnClient
    })

    const result = await owner.handoffFromPty({
      claim: claim(),
      sessionFile: '/sessions/current.jsonl',
      spawnOptions,
      provePtyExit: async () => {
        order.push('prove-pty-exit')
        return { status: 'exited' }
      }
    })

    expect(result.status).toBe('acquired')
    expect(order).toEqual(['prove-pty-exit', 'release-pty', 'spawn', 'switch'])
    expect(spawnClient).toHaveBeenCalledWith({
      ...spawnOptions,
      sessionMode: 'session-owning'
    })
  })
  // Lifecycle recovery (phase `pty-hook-lifecycle`): a child that already
  // died makes every command reject, so the state read at the top of
  // handoffToPty used to collapse "provably dead" into "unverifiable" and
  // fail closed forever — leaking the claim and stranding the pane, which
  // by then has no PTY either (acquisition killed it). Fail-closed exists
  // to protect LIVE work; a proven-exited child has none.
  it('releases the claim on a proven-exited child whose state can no longer be read', async () => {
    const order: string[] = []
    const client = fakeClient({
      getState: vi.fn(async () => {
        order.push('get-state')
        throw new Error('OMP RPC client is not available')
      }),
      dispose: vi.fn(() => order.push('dispose'))
    })
    const registry = new ClaimedAgentPtyOwnerRegistry()
    const buildResumeLaunch = vi.fn(() => 'must-not-run')
    const owner = new OmpRpcSessionOwner({
      registry,
      spawnClient: () => client,
      proveRpcExit: async (): Promise<OmpRpcOwnerExitVerdict> => {
        order.push('prove-exit')
        return { status: 'exited' }
      },
      buildResumeLaunch
    })
    const session = acquiredSession(await owner.acquire({ claim: claim(), spawnOptions })).session

    const result = await owner.handoffToPty({ session, baseCommand: 'omp', shell: 'posix' })

    expect(result).toEqual({
      status: 'already-exited',
      reason: 'OMP RPC client is not available'
    })
    expect(registry.findRpc(claim())).toBeNull()
    // Exit is PROVEN before anything is torn down, exactly as the settled
    // path does — this branch adds a verdict, it does not skip the gate.
    expect(order).toEqual(['get-state', 'prove-exit', 'dispose'])
    // No live child ever reported an identity here, so there is no resume
    // command to build; the pane's respawn context comes from the renderer.
    expect(buildResumeLaunch).not.toHaveBeenCalled()
  })

  // The other half of the same discrimination: a protocol fault makes
  // commands reject while the child may still be streaming. Unreadable is
  // not dead, so this must stay fail-closed with the claim held.
  it('keeps failing closed when an unreadable child cannot be proven exited', async () => {
    const client = fakeClient({
      getState: vi.fn(async () => {
        throw new Error('OMP RPC client is not available')
      })
    })
    const registry = new ClaimedAgentPtyOwnerRegistry()
    const owner = new OmpRpcSessionOwner({
      registry,
      spawnClient: () => client,
      proveRpcExit: async (): Promise<OmpRpcOwnerExitVerdict> => ({
        status: 'unverifiable',
        reason: 'OMP RPC child exit was not proven before timeout'
      })
    })
    const session = acquiredSession(await owner.acquire({ claim: claim(), spawnOptions })).session

    await expect(
      owner.handoffToPty({ session, baseCommand: 'omp', shell: 'posix' })
    ).resolves.toEqual({
      status: 'unverifiable',
      reason: 'OMP RPC child exit was not proven before timeout'
    })
    expect(registry.findRpc(claim())).not.toBeNull()
    expect(client.dispose).not.toHaveBeenCalled()
  })

  // The same discrimination one step later in the sequence: the child was
  // still streaming at the first read and died while the settle poll was
  // waiting on it. The settle wait reports WHY it gave up, because "the
  // child stopped answering" and "a live turn ran long" demand opposite
  // verdicts — only the first may reach the exit proof.
  it('releases a child that dies during the settle wait once its exit is proven', async () => {
    const order: string[] = []
    const streamingState: OmpRpcSessionState = { ...settledState, isStreaming: true }
    const client = fakeClient({
      getState: vi.fn(async () => streamingState),
      dispose: vi.fn(() => order.push('dispose'))
    })
    const registry = new ClaimedAgentPtyOwnerRegistry()
    const buildResumeLaunch = vi.fn(() => 'must-not-run')
    const owner = new OmpRpcSessionOwner({
      registry,
      spawnClient: () => client,
      waitForSettle: async () => {
        order.push('settle')
        return {
          status: 'unverifiable',
          cause: 'state-unreadable',
          reason: 'OMP RPC client is not available'
        }
      },
      proveRpcExit: async (): Promise<OmpRpcOwnerExitVerdict> => {
        order.push('prove-exit')
        return { status: 'exited' }
      },
      buildResumeLaunch
    })
    const session = acquiredSession(await owner.acquire({ claim: claim(), spawnOptions })).session

    const result = await owner.handoffToPty({ session, baseCommand: 'omp', shell: 'posix' })

    expect(result).toEqual({
      status: 'already-exited',
      reason: 'OMP RPC client is not available'
    })
    expect(registry.findRpc(claim())).toBeNull()
    expect(order).toEqual(['settle', 'prove-exit', 'dispose'])
    expect(buildResumeLaunch).not.toHaveBeenCalled()
  })

  // A child that stops answering mid-settle but cannot be proven exited is
  // still live work: the claim stays held and nothing is disposed.
  it('keeps the claim when a child that stops answering mid-settle is not proven exited', async () => {
    const streamingState: OmpRpcSessionState = { ...settledState, isStreaming: true }
    const client = fakeClient({ getState: vi.fn(async () => streamingState) })
    const registry = new ClaimedAgentPtyOwnerRegistry()
    const owner = new OmpRpcSessionOwner({
      registry,
      spawnClient: () => client,
      waitForSettle: async () => ({
        status: 'unverifiable',
        cause: 'state-unreadable',
        reason: 'OMP RPC client is not available'
      }),
      proveRpcExit: async (): Promise<OmpRpcOwnerExitVerdict> => ({
        status: 'unverifiable',
        reason: 'OMP RPC child exit was not proven before timeout'
      })
    })
    const session = acquiredSession(await owner.acquire({ claim: claim(), spawnOptions })).session

    await expect(
      owner.handoffToPty({ session, baseCommand: 'omp', shell: 'posix' })
    ).resolves.toEqual({
      status: 'unverifiable',
      reason: 'OMP RPC child exit was not proven before timeout'
    })
    expect(registry.findRpc(claim())).not.toBeNull()
    expect(client.dispose).not.toHaveBeenCalled()
  })

  // XLR-040 (cross-lab review): the exit proof is a DEADLINE, and a
  // SIGTERM-delayed child routinely outlives it. Both callers below have
  // already forgotten the session by the time it finally dies, so a claim kept
  // on that timeout was kept forever — every later acquisition of that session
  // conflicted until app restart. The release has to be bound to the exit
  // itself, not only to the one bounded wait.
  it('frees a retired session claim when its child exits after the proof deadline (XLR-040)', async () => {
    const { promise: exited, resolve: resolveExit } = Promise.withResolvers<OmpRpcExit>()
    const client = fakeClient({ whenExited: vi.fn(() => exited) })
    const registry = new ClaimedAgentPtyOwnerRegistry()
    const owner = new OmpRpcSessionOwner({
      registry,
      spawnClient: () => client,
      proveRpcExit: async (): Promise<OmpRpcOwnerExitVerdict> => ({
        status: 'unverifiable',
        reason: 'OMP RPC child exit was not proven before timeout'
      })
    })
    const session = acquiredSession(await owner.acquire({ claim: claim(), spawnOptions })).session

    await expect(owner.disposeAndReleaseClaim(session)).resolves.toBe(false)
    expect(registry.findRpc(claim())).not.toBeNull()

    resolveExit({ code: 0, signal: null })

    await vi.waitFor(() => expect(registry.findRpc(claim())).toBeNull())
  })

  it('frees a failed-spawn cleanup claim when its child exits after the proof deadline (XLR-040)', async () => {
    const { promise: exited, resolve: resolveExit } = Promise.withResolvers<OmpRpcExit>()
    const client = fakeClient({
      whenExited: vi.fn(() => exited),
      switchSession: vi.fn(async () => {
        throw new Error('switch_session transport failure')
      })
    })
    const registry = new ClaimedAgentPtyOwnerRegistry()
    const owner = new OmpRpcSessionOwner({
      registry,
      spawnClient: () => client,
      proveRpcExit: async (): Promise<OmpRpcOwnerExitVerdict> => ({
        status: 'unverifiable',
        reason: 'OMP RPC child exit was not proven before timeout'
      })
    })

    const result = await owner.acquire({
      claim: claim(),
      spawnOptions,
      sessionFile: '/sessions/current.jsonl'
    })

    expect(result.status).toBe('spawn-failed')
    expect(registry.findRpc(claim())).not.toBeNull()

    resolveExit({ code: 0, signal: null })

    await vi.waitFor(() => expect(registry.findRpc(claim())).toBeNull())
  })

  it('frees a disposed hand-off claim when its child exits after the proof deadline, and a retry still reads as released', async () => {
    const { promise: exited, resolve: resolveExit } = Promise.withResolvers<OmpRpcExit>()
    let disposed = false
    const client = fakeClient({
      whenExited: vi.fn(() => exited),
      dispose: vi.fn(() => {
        disposed = true
      }),
      getState: vi.fn(async () => {
        if (disposed) {
          throw new Error('OMP RPC client is not available')
        }
        return settledState
      })
    })
    const registry = new ClaimedAgentPtyOwnerRegistry()
    let exitProven = false
    const owner = new OmpRpcSessionOwner({
      registry,
      spawnClient: () => client,
      proveRpcExit: async (): Promise<OmpRpcOwnerExitVerdict> =>
        exitProven
          ? { status: 'exited' }
          : { status: 'unverifiable', reason: 'OMP RPC child exit was not proven before timeout' }
    })
    const session = acquiredSession(await owner.acquire({ claim: claim(), spawnOptions })).session

    // The settled child was SIGTERMed but outlived the proof deadline: the
    // caller keeps the session for a retry, and the claim must ride the exit.
    await expect(
      owner.handoffToPty({ session, baseCommand: 'omp', shell: 'posix' })
    ).resolves.toEqual({
      status: 'unverifiable',
      reason: 'OMP RPC child exit was not proven before timeout'
    })
    expect(client.dispose).toHaveBeenCalledTimes(1)
    expect(registry.findRpc(claim())).not.toBeNull()

    resolveExit({ code: 0, signal: null })
    await vi.waitFor(() => expect(registry.findRpc(claim())).toBeNull())

    // The registry's retry must not be told the claim "changed" by the very
    // release this owner performed on its behalf.
    exitProven = true
    await expect(
      owner.handoffToPty({ session, baseCommand: 'omp', shell: 'posix' })
    ).resolves.toMatchObject({ status: 'already-exited' })
  })
})

describe('waitForOmpRpcSettle', () => {
  it('separates an unreadable child from a turn that merely ran long', async () => {
    const client = fakeClient({
      getState: vi.fn(async () => {
        throw new Error('OMP RPC client is not available')
      })
    })

    await expect(waitForOmpRpcSettle(client)).resolves.toEqual({
      status: 'unverifiable',
      cause: 'state-unreadable',
      reason: 'OMP RPC client is not available'
    })
  })

  // R2-002: the wait used to check the clock BEFORE reading, so the last
  // thing it observed was a poll taken up to one interval before the
  // deadline and the final sleep went unwatched. A child that exited in
  // that window was reported as `timeout` — live work — which skips the
  // exit proof in handoffToPty and strands its claim. Every exit from the
  // loop must now be preceded by a fresh read.
  it('re-reads state after the deadline so a child that dies in the final sleep is unreadable', async () => {
    vi.useFakeTimers()
    try {
      const streamingState: OmpRpcSessionState = { ...settledState, isStreaming: true }
      const deadlineAt = Date.now() + 10_000
      const client = fakeClient({
        getState: vi.fn(async () => {
          if (Date.now() >= deadlineAt) {
            throw new Error('OMP RPC client is not available')
          }
          return streamingState
        })
      })

      const settle = waitForOmpRpcSettle(client)
      await vi.advanceTimersByTimeAsync(10_000)

      await expect(settle).resolves.toEqual({
        status: 'unverifiable',
        cause: 'state-unreadable',
        reason: 'OMP RPC client is not available'
      })
    } finally {
      vi.useRealTimers()
    }
  })

  // The other half of the same boundary: a child still answering at the
  // deadline is a long turn, not a dead one, and must stay fail-closed.
  it('reports a still-answering child at the deadline as a long turn, not an unreadable one', async () => {
    vi.useFakeTimers()
    try {
      const streamingState: OmpRpcSessionState = { ...settledState, isStreaming: true }
      const client = fakeClient({ getState: vi.fn(async () => streamingState) })

      const settle = waitForOmpRpcSettle(client)
      await vi.advanceTimersByTimeAsync(10_000)

      await expect(settle).resolves.toEqual({
        status: 'unverifiable',
        cause: 'timeout',
        reason: 'OMP RPC session did not settle before timeout'
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
