import { beforeEach, describe, expect, it, vi } from 'vitest'

const hostRef: { current: unknown } = { current: null }
const createSpy = vi.fn()

vi.mock('../../../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))
vi.mock('./structured-agent-session-create', () => ({
  createStructuredAgentSessionForWorktree: (...args: unknown[]) => createSpy(...args)
}))

const {
  createStructuredWorkerSession,
  releaseStructuredWorkerSession,
  sendStructuredWorkerPreamble,
  structuredWorkerHoldId
} = await import('./orchestration-structured-worker-session')
const { isUnknownWorkerStartOutcome } = await import('./orchestration/worker/worker-topology')
const { structuredWorkerIdentities } = await import('../../structured-worker-identity')
const { structuredWorkerChildIdentityEnv } =
  await import('../../structured-worker-child-identity-env')

function installHost() {
  const hold = vi.fn(async () => {})
  const release = vi.fn()
  const dispose = vi.fn()
  hostRef.current = {
    setSessionTabVisibility: async () => {},
    close: async () => {},
    deps: {
      store: {
        getRecord: () => ({
          location: { executionHostId: 'local', wslDistro: null },
          lease: { runtimeFence: 2, runtimeKind: 'native', claimStatus: 'live' }
        })
      }
    },
    hold,
    release,
    subscribe: () => dispose
  }
  return { hold, release, dispose }
}

describe('structured worker session hold', () => {
  beforeEach(() => {
    structuredWorkerIdentities.clear()
    createSpy.mockReset()
    createSpy.mockImplementation(async (args: { envelope: { sessionId: string } }) => ({
      ok: true,
      value: { sessionId: args.envelope.sessionId }
    }))
  })

  it('takes a resume-capable hold at start and releases it only on settlement', async () => {
    const { hold, release, dispose } = installHost()
    const created = await createStructuredWorkerSession({
      runtime: { ensureStructuredAgentSessionHost: async () => {} } as never,
      worktreeId: 'wt_1',
      agent: 'claude',
      dispatchId: 'd1',
      onJournalActivity: () => {}
    })
    // Without the hold, the release clock evicts the provider child 15s after a user closes the
    // worker's chat tab, killing an idle worker mid-dispatch.
    expect(hold).toHaveBeenCalledWith(created.identity.sessionId, structuredWorkerHoldId('d1'))
    expect(release).not.toHaveBeenCalled()

    releaseStructuredWorkerSession('d1')
    expect(release).toHaveBeenCalledWith(created.identity.sessionId, structuredWorkerHoldId('d1'))
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(structuredWorkerIdentities.get(created.identity.handle)).toBeNull()
    // A second settlement is a no-op rather than a second release of the same holder.
    releaseStructuredWorkerSession('d1')
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('registers the identity BEFORE the session is created, so the child gets the handle', async () => {
    installHost()
    let envAtSpawn: Record<string, string> | undefined
    createSpy.mockImplementation(async (args: { envelope: { sessionId: string } }) => {
      // `attach` is what spawns the provider child, and the child's env is read from the registry
      // at spawn time. Registering afterwards ships a worker with no ORCA_TERMINAL_HANDLE.
      envAtSpawn = structuredWorkerChildIdentityEnv(args.envelope.sessionId, {})
      return { ok: true, value: { sessionId: args.envelope.sessionId } }
    })
    const created = await createStructuredWorkerSession({
      runtime: { ensureStructuredAgentSessionHost: async () => {} } as never,
      worktreeId: 'wt_1',
      agent: 'claude',
      dispatchId: 'd_spawn',
      onJournalActivity: () => {}
    })
    expect(envAtSpawn?.ORCA_TERMINAL_HANDLE).toBe(created.identity.handle)
    expect(envAtSpawn?.ORCA_CLI_COMMAND).toBe('orca')
    expect(envAtSpawn?.ORCA_PANE_KEY).toBeUndefined()
    releaseStructuredWorkerSession('d_spawn')
  })

  it('forgets the identity and discards the session when the start fails', async () => {
    const { hold } = installHost()
    hold.mockRejectedValueOnce(new Error('hold refused'))
    const closed: string[] = []
    ;(hostRef.current as { close: (id: string) => Promise<void> }).close = async (id) => {
      closed.push(id)
    }
    await expect(
      createStructuredWorkerSession({
        runtime: { ensureStructuredAgentSessionHost: async () => {} } as never,
        worktreeId: 'wt_1',
        agent: 'claude',
        dispatchId: 'd_fail',
        onJournalActivity: () => {}
      })
    ).rejects.toThrow('hold refused')
    // Neither a live provider child nor a registry entry may outlive the failed start.
    expect(closed).toHaveLength(1)
    expect(structuredWorkerIdentities.getBySessionId(closed[0]!)).toBeNull()
  })

  it('discards the session when the create settled UNKNOWN after attach', async () => {
    installHost()
    const closed: string[] = []
    ;(hostRef.current as { close: (id: string) => Promise<void> }).close = async (id) => {
      closed.push(id)
    }
    // `commit` answers this after `attach` SUCCEEDED and only the tab publish failed, so the
    // provider child is live. Reading it as "refused, nothing created" strands that child with no
    // hold and no binding, and nothing else in the runtime ever retires it.
    createSpy.mockImplementation(async () => ({
      ok: false,
      refusal: {
        code: 'agent_session_operation_unknown',
        message: 'The chat may have been created, but its tab could not be confirmed.'
      }
    }))
    await expect(
      createStructuredWorkerSession({
        runtime: { ensureStructuredAgentSessionHost: async () => {} } as never,
        worktreeId: 'wt_1',
        agent: 'claude',
        dispatchId: 'd_unknown',
        onJournalActivity: () => {}
      })
    ).rejects.toThrow(/was refused/)
    expect(closed).toHaveLength(1)
    expect(structuredWorkerIdentities.getBySessionId(closed[0]!)).toBeNull()
  })

  it('does not close anything when the create refusal proves nothing was created', async () => {
    installHost()
    const closed: string[] = []
    ;(hostRef.current as { close: (id: string) => Promise<void> }).close = async (id) => {
      closed.push(id)
    }
    createSpy.mockImplementation(async () => ({
      ok: false,
      refusal: {
        code: 'structured_agent_session_unsupported',
        message: 'Orca cannot open a structured agent chat for this workspace.'
      }
    }))
    await expect(
      createStructuredWorkerSession({
        runtime: { ensureStructuredAgentSessionHost: async () => {} } as never,
        worktreeId: 'wt_1',
        agent: 'claude',
        dispatchId: 'd_definitive',
        onJournalActivity: () => {}
      })
    ).rejects.toThrow(/was refused/)
    expect(closed).toEqual([])
  })

  it('registers a random handle bound to the created session', async () => {
    installHost()
    const created = await createStructuredWorkerSession({
      runtime: { ensureStructuredAgentSessionHost: async () => {} } as never,
      worktreeId: 'wt_1',
      agent: 'codex',
      dispatchId: 'd2',
      onJournalActivity: () => {}
    })
    expect(created.identity.handle.startsWith('structworker_')).toBe(true)
    expect(created.identity.processIncarnation).toBe(`structured:${created.identity.sessionId}`)
    expect(structuredWorkerIdentities.getBySessionId(created.identity.sessionId)?.agent).toBe(
      'codex'
    )
    releaseStructuredWorkerSession('d2')
  })

  it('does not activate the worker session, so a dispatch cannot steal the surface', async () => {
    installHost()
    await createStructuredWorkerSession({
      runtime: { ensureStructuredAgentSessionHost: async () => {} } as never,
      worktreeId: 'wt_1',
      agent: 'claude',
      dispatchId: 'd3',
      onJournalActivity: () => {}
    })
    expect(createSpy.mock.calls[0]![0].activate).toBe(false)
    releaseStructuredWorkerSession('d3')
  })

  it('refuses a session pinned to a non-local execution host', async () => {
    installHost()
    ;(hostRef.current as { deps: { store: { getRecord: () => unknown } } }).deps.store.getRecord =
      () => ({
        location: { executionHostId: 'ssh-1', wslDistro: null },
        lease: { runtimeFence: 2, runtimeKind: 'native', claimStatus: 'live' }
      })
    await expect(
      createStructuredWorkerSession({
        runtime: { ensureStructuredAgentSessionHost: async () => {} } as never,
        worktreeId: 'wt_1',
        agent: 'claude',
        dispatchId: 'd4',
        onJournalActivity: () => {}
      })
    ).rejects.toThrow(/local execution host/)
  })
})

describe('structured worker dispatch preamble', () => {
  function hostWithSubmission(submission: Record<string, unknown>) {
    return {
      deps: { store: { getRecord: () => ({ lease: { runtimeFence: 7 } }) } },
      send: async () => ({ ok: true, value: { clientMessageId: 'c1', submission } })
    } as never
  }

  const send = (host: never) =>
    sendStructuredWorkerPreamble({ host, sessionId: 's1', dispatchId: 'd1', preamble: 'spec' })

  it('reports the preamble delivered only on an accepted submission', async () => {
    await expect(
      send(hostWithSubmission({ dispatchState: 'accepted', reason: null }))
    ).resolves.toBeUndefined()
  })

  it('never claims delivery for a submission the provider never acknowledged', async () => {
    // `dispatchSafely` turns ANY thrown adapter call — provider child dead, transport dropped —
    // into `unknown`, and `performSend` still returns ok. Reporting that as `dispatch_input:
    // accepted` marks the worker ready with no task, and the coordinator blocks in
    // `check --wait --types worker_done` until it times out.
    for (const dispatchState of ['unknown', 'pending'] as const) {
      const error = await send(
        hostWithSubmission({ dispatchState, reason: 'provider child exited' })
      ).catch((thrown: unknown) => thrown)
      expect((error as { code?: string }).code).toBe('operation_unknown')
      // The wiring, not just the throw: this is the code that makes the start receipt
      // `outcome_unknown` with the worker-show / worker-abandon recovery commands.
      expect(isUnknownWorkerStartOutcome(error, 'dispatch_input')).toBe(true)
    }
  })

  it('keeps a rejected preamble a proven failure rather than an unknown one', async () => {
    const error = await send(
      hostWithSubmission({ dispatchState: 'rejected', reason: 'fence moved' })
    ).catch((thrown: unknown) => thrown)
    expect((error as Error).message).toMatch(/rejected: fence moved/)
    expect(isUnknownWorkerStartOutcome(error, 'dispatch_input')).toBe(false)
  })
})
