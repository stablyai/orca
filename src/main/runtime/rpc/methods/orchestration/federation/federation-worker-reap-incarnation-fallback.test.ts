import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../../../shared/protocol-version'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db'
import { ORCHESTRATION_METHODS } from '../../orchestration'
import { eraseRpcMethods } from '../../../core'

describe('federation worker reap incarnation fallback (#18803)', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  const HOME_FINGERPRINT = 'home-peer-fingerprint'
  const DISPATCH_ID = 'ctx_federation_18803'
  const STALE_HANDLE = 'term_remote_stale'
  const REMINTED_HANDLE = 'term_remote_reminted'
  const PANE_KEY = 'tab_remote:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const INCARNATION = 'runtime_worker:pty:1'
  const LOCAL_HOST_SCOPE = JSON.stringify({ kind: 'local', hostId: 'local' })

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)

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
      terminalHandle: STALE_HANDLE,
      setupState: 'not_applicable',
      effects: [{ kind: 'terminal', action: 'created', id: STALE_HANDLE }],
      hostScope: LOCAL_HOST_SCOPE,
      terminalOwnership: 'created'
    })

    db.markRemoteAttachmentReady(DISPATCH_ID)

    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === STALE_HANDLE || handle === REMINTED_HANDLE ? PANE_KEY : null
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
      handle === STALE_HANDLE || handle === REMINTED_HANDLE ? INCARNATION : null
    )
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation((handle) =>
      handle === REMINTED_HANDLE
        ? ({
            terminalHandle: handle,
            paneKey: PANE_KEY,
            processIncarnation: INCARNATION,
            hostScope: { kind: 'local', hostId: 'local' }
          } as never)
        : null
    )
    vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({
      handle: REMINTED_HANDLE,
      ptyKilled: true,
      ptyStopVerdict: 'exited'
    } as never)
  })

  afterEach(() => db.close())

  async function call(name: string, params: Record<string, unknown>) {
    const method = eraseRpcMethods(ORCHESTRATION_METHODS).find(
      (candidate) => candidate.name === name
    )
    if (!method) {
      throw new Error(`Method not found: ${name}`)
    }
    return method.handler(method.params!.parse(params), {
      runtime,
      authenticatedCallerFingerprint: HOME_FINGERPRINT
    } as never)
  }

  it('closes the live terminal when durable handle is stale but incarnation still matches (#18803)', async () => {
    // Durable handle fails to resolve (renderer graph epoch bump on headless worker host)
    vi.spyOn(runtime, 'showTerminal').mockImplementation(async (handle) => {
      if (handle === STALE_HANDLE) {
        throw new Error('terminal_handle_stale')
      }
      if (handle === REMINTED_HANDLE) {
        return {
          handle: REMINTED_HANDLE,
          worktreeId: 'repo::remote-worktree',
          connected: true,
          status: 'running'
        } as never
      }
      return null as never
    })

    const resolveByIncarnation = vi.fn().mockReturnValue(REMINTED_HANDLE)
    runtime.resolveTerminalHandleByProcessIncarnation = resolveByIncarnation

    const result = (await call('orchestration.federationStop', {
      dispatchId: DISPATCH_ID
    })) as {
      dispatchId: string
      state: string
      alreadySettled: boolean
      processAction: string
    }

    expect(resolveByIncarnation).toHaveBeenCalledWith(INCARNATION, LOCAL_HOST_SCOPE)
    expect(runtime.closeTerminal).toHaveBeenCalledTimes(1)
    expect(runtime.closeTerminal).toHaveBeenCalledWith(REMINTED_HANDLE)
    expect(result).toMatchObject({
      dispatchId: DISPATCH_ID,
      state: 'stopped',
      alreadySettled: false,
      processAction: 'closed_agent_terminal'
    })
  })

  it('leaves dispatch stop_unknown and closes nothing when incarnation does not match a live pty', async () => {
    vi.spyOn(runtime, 'showTerminal').mockRejectedValue(new Error('terminal_handle_stale'))

    const resolveByIncarnation = vi.fn().mockReturnValue(null)
    runtime.resolveTerminalHandleByProcessIncarnation = resolveByIncarnation

    const result = (await call('orchestration.federationStop', {
      dispatchId: DISPATCH_ID
    })) as {
      dispatchId: string
      state: string
      alreadySettled: boolean
      processAction: string
    }

    expect(resolveByIncarnation).toHaveBeenCalledWith(INCARNATION, LOCAL_HOST_SCOPE)
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      dispatchId: DISPATCH_ID,
      state: 'stop_unknown',
      alreadySettled: false,
      processAction: 'none'
    })
  })

  it('allows federationRead through the reminted terminal handle', async () => {
    vi.spyOn(runtime, 'showTerminal').mockImplementation(async (handle) => {
      if (handle === STALE_HANDLE) {
        return null as never
      }
      if (handle === REMINTED_HANDLE) {
        return {
          handle: REMINTED_HANDLE,
          worktreeId: 'repo::remote-worktree',
          connected: true,
          status: 'running'
        } as never
      }
      return null as never
    })

    const resolveByIncarnation = vi.fn().mockReturnValue(REMINTED_HANDLE)
    runtime.resolveTerminalHandleByProcessIncarnation = resolveByIncarnation

    vi.spyOn(runtime, 'readTerminal').mockResolvedValue({
      tail: ['worker output line 1', 'worker output line 2'],
      cursor: '10',
      returnedLineCount: 2
    } as never)

    const result = (await call('orchestration.federationRead', {
      dispatchId: DISPATCH_ID
    })) as {
      terminal: { tail: string[] }
    }

    expect(resolveByIncarnation).toHaveBeenCalledWith(INCARNATION, LOCAL_HOST_SCOPE)
    expect(runtime.readTerminal).toHaveBeenCalledWith(REMINTED_HANDLE, expect.anything())
    expect(result.terminal.tail).toEqual(['worker output line 1', 'worker output line 2'])
  })

  it('shows the reminted terminal and reports live in federationShow', async () => {
    vi.spyOn(runtime, 'showTerminal').mockImplementation(async (handle) => {
      if (handle === STALE_HANDLE) {
        return null as never
      }
      if (handle === REMINTED_HANDLE) {
        return {
          handle: REMINTED_HANDLE,
          worktreeId: 'repo::remote-worktree',
          connected: true,
          status: 'running'
        } as never
      }
      return null as never
    })

    const resolveByIncarnation = vi.fn().mockReturnValue(REMINTED_HANDLE)
    runtime.resolveTerminalHandleByProcessIncarnation = resolveByIncarnation

    const result = (await call('orchestration.federationShow', {
      dispatchId: DISPATCH_ID
    })) as {
      terminal: { handle: string }
      observation: { status: string; exactWorker: boolean }
    }

    expect(resolveByIncarnation).toHaveBeenCalledWith(INCARNATION, LOCAL_HOST_SCOPE)
    expect(result.terminal.handle).toBe(REMINTED_HANDLE)
    expect(result.observation).toMatchObject({
      status: 'live',
      exactWorker: true
    })
  })
})
