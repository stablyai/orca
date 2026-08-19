import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../shared/protocol-version'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { ORCHESTRATION_METHODS } from './orchestration'

// The federation host runs its own copy of the observation and stop logic, so
// it needs the same rule: lost contact with a worker's host is not an exit, and
// a close it could not confirm must not be relayed home as a settled stop.

const HOME_FINGERPRINT = 'home-peer-fingerprint'
const DISPATCH_ID = 'ctx_federation_verdict'
const HANDLE = 'term_remote_worker'
const PANE_KEY = 'tab_remote:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const INCARNATION = 'runtime:pty:7'
const SSH_PROVIDER_GONE = 'its SSH provider is no longer registered'

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
      effects: [{ kind: 'terminal', action: 'created', id: HANDLE }]
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
    await expect(
      call('orchestration.federationShow', { dispatchId: DISPATCH_ID })
    ).resolves.toMatchObject({ observation: { status: 'exited', exactWorker: true } })
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
