import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../../../../shared/constants'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../../../shared/protocol-version'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db'
import { ORCHESTRATION_METHODS } from '../../orchestration'

// The federation host runs its own copy of the observation and stop logic, so
// it needs the same rule: lost contact with a worker's host is not an exit, and
// a close it could not confirm must not be relayed home as a settled stop.

const HOME_FINGERPRINT = 'home-peer-fingerprint'
const DISPATCH_ID = 'ctx_federation_verdict'
const HANDLE = 'term_remote_worker'
const PANE_KEY = 'tab_remote:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const INCARNATION = 'runtime:pty:7'
const SSH_PROVIDER_GONE = 'its SSH provider is no longer registered'
const REAL_PTY_ID = 'pty-federation-liveness'
const REAL_WORKTREE_ID = 'repo-federation::/tmp/federation-liveness'

function realRuntimeStore() {
  return {
    getWorkspaceSession: vi.fn(() => getDefaultWorkspaceSession()),
    setWorkspaceSession: vi.fn(),
    getWorkspaceSessionHostIds: vi.fn(() => ['local']),
    getRepos: vi.fn(() => [
      {
        id: 'repo-federation',
        path: '/tmp/federation-liveness',
        displayName: 'federation-liveness',
        badgeColor: '#000000',
        addedAt: 0
      }
    ]),
    getAllWorktreeMeta: vi.fn(() => ({})),
    getWorktreeMeta: vi.fn(() => undefined),
    setWorktreeMeta: vi.fn(),
    removeWorktreeMeta: vi.fn(),
    getSettings: vi.fn(() => ({ workspaceDir: '/tmp/workspaces' })),
    getProjects: vi.fn(() => [])
  }
}

describe('federation host liveness verdicts', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue(PANE_KEY)
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue(INCARNATION)
    vi.spyOn(runtime, 'showTerminal').mockResolvedValue({
      handle: HANDLE,
      worktreeId: 'repo::remote-worktree',
      connected: false,
      status: 'exited'
    } as never)
    db.createRemoteDispatchAttachment({
      runId: 'run-home',
      dispatchId: DISPATCH_ID,
      taskId: 'task_remote',
      homePeerFingerprint: HOME_FINGERPRINT,
      protocolVersion: ORCHESTRATION_CONTRACT_VERSION,
      runtimeEpoch: runtime.getRuntimeId(),
      mutationReceipt: {
        callerFingerprint: HOME_FINGERPRINT,
        requestId: 'rpc_attach',
        method: 'orchestration.federationStart',
        payloadHash: 'hash'
      }
    })
    db.prepareRemoteAttachmentAuthority({
      dispatchId: DISPATCH_ID,
      paneKey: PANE_KEY,
      processIncarnation: INCARNATION,
      worktreeId: 'repo::remote-worktree',
      terminalHandle: HANDLE,
      setupState: 'not_applicable',
      effects: [{ kind: 'terminal', action: 'created', id: HANDLE }],
      terminalOwnership: 'created'
    })
    db.markRemoteAttachmentReady(DISPATCH_ID)
  })

  afterEach(() => db.close())

  async function call(name: string, params: Record<string, unknown>) {
    const method = ORCHESTRATION_METHODS.find((candidate) => candidate.name === name)
    if (!method) {
      throw new Error(`Method not found: ${name}`)
    }
    return method.handler(method.params!.parse(params), {
      runtime,
      authenticatedCallerFingerprint: HOME_FINGERPRINT
    } as never)
  }

  async function createRealHost(connectionId: string | null = null) {
    const hostDb = new OrchestrationDb(':memory:')
    const hostRuntime = new OrcaRuntimeService(realRuntimeStore() as never)
    hostRuntime.setOrchestrationDb(hostDb)
    hostRuntime.attachWindow(1)
    hostRuntime.syncWindowGraph(1, { tabs: [], leaves: [] })
    hostRuntime.registerPty(REAL_PTY_ID, REAL_WORKTREE_ID, connectionId, {
      tabId: 'tab_federation_liveness',
      leafId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      incarnationId: 'incarnation-real'
    })
    const terminal = (await hostRuntime.listTerminals(`id:${REAL_WORKTREE_ID}`)).terminals[0]
    if (!terminal) {
      throw new Error('Expected the real runtime PTY to be listed')
    }
    hostDb.createRemoteDispatchAttachment({
      runId: 'run-home',
      dispatchId: DISPATCH_ID,
      taskId: 'task_remote',
      homePeerFingerprint: HOME_FINGERPRINT,
      protocolVersion: ORCHESTRATION_CONTRACT_VERSION,
      runtimeEpoch: hostRuntime.getRuntimeId(),
      mutationReceipt: {
        callerFingerprint: HOME_FINGERPRINT,
        requestId: 'rpc_real_attach',
        method: 'orchestration.federationStart',
        payloadHash: 'real-hash'
      }
    })
    hostDb.prepareRemoteAttachmentAuthority({
      dispatchId: DISPATCH_ID,
      paneKey: hostRuntime.getTerminalPaneKey(terminal.handle)!,
      processIncarnation: hostRuntime.getTerminalProcessIncarnation(terminal.handle)!,
      worktreeId: REAL_WORKTREE_ID,
      terminalHandle: terminal.handle,
      setupState: 'not_applicable',
      effects: [{ kind: 'terminal', action: 'created', id: terminal.handle }],
      terminalOwnership: 'created'
    })
    hostDb.markRemoteAttachmentReady(DISPATCH_ID)
    const callHost = async (name: string, params: Record<string, unknown>) => {
      const method = ORCHESTRATION_METHODS.find((candidate) => candidate.name === name)
      if (!method) {
        throw new Error(`Method not found: ${name}`)
      }
      return method.handler(method.params!.parse(params), {
        runtime: hostRuntime,
        authenticatedCallerFingerprint: HOME_FINGERPRINT
      } as never)
    }
    return { hostDb, hostRuntime, terminal, callHost }
  }

  it('reports lost contact as unverifiable rather than an observed exit', async () => {
    vi.spyOn(runtime, 'getTerminalLivenessVerdict').mockReturnValue({
      status: 'unverifiable',
      reason: SSH_PROVIDER_GONE
    })

    await expect(
      call('orchestration.federationShow', { dispatchId: DISPATCH_ID })
    ).resolves.toMatchObject({
      observation: { status: 'unverifiable', exactWorker: true, reason: SSH_PROVIDER_GONE }
    })
  })

  it('uses the canonical live verdict for an observed process', async () => {
    vi.spyOn(runtime, 'showTerminal').mockResolvedValue({
      handle: HANDLE,
      worktreeId: 'repo::remote-worktree',
      connected: true,
      status: 'running'
    } as never)
    vi.spyOn(runtime, 'getTerminalLivenessVerdict').mockReturnValue({
      status: 'live',
      ptyIds: [HANDLE]
    })

    await expect(
      call('orchestration.federationShow', { dispatchId: DISPATCH_ID })
    ).resolves.toMatchObject({ observation: { status: 'live', exactWorker: true } })
  })

  it('still reports a locally observed exit as exited', async () => {
    vi.spyOn(runtime, 'getTerminalLivenessVerdict').mockReturnValue({ status: 'exited' })
    await expect(
      call('orchestration.federationShow', { dispatchId: DISPATCH_ID })
    ).resolves.toMatchObject({ observation: { status: 'exited', exactWorker: true } })
  })

  it('publishes positive owning-host inventory as live without a test verdict stub', async () => {
    const host = await createRealHost()
    try {
      host.hostRuntime.setPtyController({
        write: () => true,
        kill: () => true,
        hasPty: () => true,
        listProcesses: async () => [
          {
            id: REAL_PTY_ID,
            worktreeId: REAL_WORKTREE_ID,
            incarnationId: 'incarnation-real'
          }
        ],
        getForegroundProcess: async () => null
      } as never)
      await host.hostRuntime.listTerminals(`id:${REAL_WORKTREE_ID}`)
      expect(host.hostRuntime.getPtyLivenessVerdict(REAL_PTY_ID)).toEqual({
        status: 'live',
        ptyIds: [REAL_PTY_ID]
      })
      await expect(
        host.callHost('orchestration.federationShow', { dispatchId: DISPATCH_ID })
      ).resolves.toMatchObject({ observation: { status: 'live', exactWorker: true } })
      await expect(
        host.callHost('orchestration.federationFleetSnapshot', { dispatchIds: [DISPATCH_ID] })
      ).resolves.toMatchObject({
        items: [{ dispatchId: DISPATCH_ID, observation: { status: 'live' } }]
      })
    } finally {
      host.hostDb.close()
    }
  })

  it('publishes a real owning-host natural exit through show, fleet, and release', async () => {
    const host = await createRealHost()
    try {
      host.hostRuntime.onPtyExit(REAL_PTY_ID, 0, 'incarnation-real', {
        hostExitConfirmed: true
      })
      const closeTerminal = vi.spyOn(host.hostRuntime, 'closeTerminal')

      await expect(
        host.callHost('orchestration.federationShow', { dispatchId: DISPATCH_ID })
      ).resolves.toMatchObject({ observation: { status: 'exited', exactWorker: true } })
      await expect(
        host.callHost('orchestration.federationFleetSnapshot', { dispatchIds: [DISPATCH_ID] })
      ).resolves.toMatchObject({
        items: [{ dispatchId: DISPATCH_ID, observation: { status: 'exited' } }]
      })
      host.hostDb.recordRemoteAttachmentStage({
        dispatchId: DISPATCH_ID,
        state: 'succeeded',
        stage: 'worker_reported'
      })
      await expect(
        host.callHost('orchestration.federationRelease', { dispatchId: DISPATCH_ID })
      ).resolves.toMatchObject({
        state: 'released',
        processAction: 'closed_exited_terminal',
        archive: { source: 'terminal', status: 'empty' }
      })
      expect(host.hostDb.getWorkerTerminalArchive(DISPATCH_ID)).toBeDefined()
      // The exited worker still owns a terminal record and tab; release must close it.
      expect(closeTerminal).toHaveBeenCalledOnce()
    } finally {
      host.hostDb.close()
    }
  })

  it('keeps real SSH contact loss unverifiable through federation show', async () => {
    const host = await createRealHost('ssh-real-host')
    try {
      host.hostRuntime.onPtyExit(REAL_PTY_ID, -1, 'incarnation-real')

      await expect(
        host.callHost('orchestration.federationShow', { dispatchId: DISPATCH_ID })
      ).resolves.toMatchObject({
        observation: { status: 'unverifiable', exactWorker: true }
      })
    } finally {
      host.hostDb.close()
    }
  })

  // Why: the verdict register only fills on the first inventory sweep, so a PTY this host just
  // spawned has none for minutes; the fleet row read host_indeterminate the whole time.
  it('reads a freshly spawned local pane from its own connected flag before any verdict', async () => {
    vi.spyOn(runtime, 'showTerminal').mockResolvedValue({
      handle: HANDLE,
      worktreeId: 'repo::remote-worktree',
      connected: true,
      status: 'running'
    } as never)
    vi.spyOn(runtime, 'getTerminalLivenessVerdict').mockReturnValue(null)
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockReturnValue({
      hostScope: { kind: 'local', hostId: 'local' }
    } as never)

    await expect(
      call('orchestration.federationFleetSnapshot', { dispatchIds: [DISPATCH_ID] })
    ).resolves.toMatchObject({
      items: [{ dispatchId: DISPATCH_ID, observation: { status: 'live', exactWorker: true } }]
    })
  })

  it('keeps a disconnected verdict-less pane unverifiable rather than exited', async () => {
    vi.spyOn(runtime, 'getTerminalLivenessVerdict').mockReturnValue(null)
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockReturnValue(null)

    await expect(
      call('orchestration.federationShow', { dispatchId: DISPATCH_ID })
    ).resolves.toMatchObject({
      observation: { status: 'unverifiable', exactWorker: true, reason: 'missing_liveness_verdict' }
    })
  })

  it('keeps a verdict-less pane the host reaches over SSH unverifiable', async () => {
    vi.spyOn(runtime, 'showTerminal').mockResolvedValue({
      handle: HANDLE,
      worktreeId: 'repo::remote-worktree',
      connected: true,
      status: 'running'
    } as never)
    vi.spyOn(runtime, 'getTerminalLivenessVerdict').mockReturnValue(null)
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockReturnValue({
      hostScope: { kind: 'ssh', targetId: 'ssh-hop' }
    } as never)

    await expect(
      call('orchestration.federationShow', { dispatchId: DISPATCH_ID })
    ).resolves.toMatchObject({
      observation: { status: 'unverifiable', exactWorker: true, reason: 'missing_liveness_verdict' }
    })
  })

  it('keeps an old peer without a liveness verdict unverifiable', async () => {
    // Legacy hosts can return an exited-looking terminal summary but have no
    // verdict API; relay/contact state is not proof that the process exited.
    Object.defineProperty(runtime, 'getTerminalLivenessVerdict', { value: undefined })

    await expect(
      call('orchestration.federationShow', { dispatchId: DISPATCH_ID })
    ).resolves.toMatchObject({
      observation: {
        status: 'unverifiable',
        exactWorker: true,
        reason: 'missing_liveness_verdict'
      }
    })
  })

  it('still serves output for a terminal we merely lost stop-contact with', async () => {
    // Why this matters: the read gate used to reject every status except live, which
    // would refuse a connected terminal the moment a stop lost contact with it.
    vi.spyOn(runtime, 'showTerminal').mockResolvedValue({
      handle: HANDLE,
      worktreeId: 'repo::remote-worktree',
      connected: true
    } as never)
    vi.spyOn(runtime, 'getTerminalLivenessVerdict').mockReturnValue({
      status: 'unverifiable',
      reason: SSH_PROVIDER_GONE
    })

    const outcome = await call('orchestration.federationRead', {
      dispatchId: DISPATCH_ID
    }).catch((error: unknown) => error)

    expect(outcome).not.toMatchObject({ code: 'worker_identity_changed' })
  })

  it('does not relay an unconfirmed close home as a settled stop', async () => {
    vi.spyOn(runtime, 'getTerminalLivenessVerdict').mockReturnValue({
      status: 'unverifiable',
      reason: SSH_PROVIDER_GONE
    })
    const closeTerminal = vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({
      handle: HANDLE,
      tabId: 'tab_remote',
      ptyKilled: false,
      ptyStopVerdict: 'unverifiable',
      ptyStopReason: SSH_PROVIDER_GONE
    })

    const stopped = (await call('orchestration.federationStop', { dispatchId: DISPATCH_ID })) as {
      state: string
      lastError?: string
    }

    // Losing contact is a reason to report honestly, never to stop trying.
    expect(closeTerminal).toHaveBeenCalledWith(HANDLE)
    expect(stopped.state).not.toBe('stopped')
    expect(stopped.lastError).toContain('could not be confirmed stopped')
  })

  it('does not settle a bare false close as a stop', async () => {
    vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({
      handle: HANDLE,
      tabId: 'tab_remote',
      ptyKilled: false
    })

    const stopped = (await call('orchestration.federationStop', { dispatchId: DISPATCH_ID })) as {
      state: string
      lastError?: string
    }

    expect(stopped.state).not.toBe('stopped')
    expect(stopped.lastError).toContain('could not be confirmed stopped')
  })

  it('still settles a confirmed close as a stop', async () => {
    vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({
      handle: HANDLE,
      tabId: 'tab_remote',
      ptyKilled: true
    })

    const stopped = (await call('orchestration.federationStop', { dispatchId: DISPATCH_ID })) as {
      state: string
      processAction: string
    }

    expect(stopped.state).toBe('stopped')
    expect(stopped.processAction).toBe('closed_agent_terminal')
  })
})
