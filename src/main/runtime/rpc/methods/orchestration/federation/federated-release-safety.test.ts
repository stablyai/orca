import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../../../shared/protocol-version'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db'
import { ORCHESTRATION_METHODS } from '../../orchestration'

const HOME_FINGERPRINT = 'home-peer'
const PANE_KEY = 'tab_remote:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const PROCESS_INCARNATION = 'runtime:pty:7'
const TERMINAL_HANDLE = 'term_remote'

describe('federated worker release ownership', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue(PANE_KEY)
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue(PROCESS_INCARNATION)
    vi.spyOn(runtime, 'showTerminal').mockResolvedValue({
      handle: TERMINAL_HANDLE,
      worktreeId: 'repo::remote',
      connected: true,
      status: 'running'
    } as never)
    vi.spyOn(runtime, 'getTerminalLivenessVerdict').mockReturnValue({
      status: 'live',
      ptyIds: [TERMINAL_HANDLE]
    })
    vi.spyOn(runtime, 'closeTerminal')
  })

  afterEach(() => db.close())

  it('rejects release while the remote worker is active', async () => {
    createAttachment('ctx_active', 'created')

    await expect(call('orchestration.federationRelease', 'ctx_active')).rejects.toThrow(
      /only a settled worker can release/
    )
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
    expect(db.getWorkerTerminalResourceByOwner('ctx_active')).toMatchObject({
      ownership_state: 'owned',
      release_state: 'not_requested'
    })
  })

  it('transfers an exact reused terminal lease and fences release through the old Dispatch', async () => {
    createAttachment('ctx_old', 'created')
    settleAttachment('ctx_old')
    const original = db.getWorkerTerminalResourceByOwner('ctx_old')

    createAttachment('ctx_successor', 'external')

    expect(db.getWorkerTerminalResourceByOwner('ctx_successor')?.id).toBe(original?.id)
    expect(db.getWorkerTerminalResourceByOwner('ctx_old')).toBeUndefined()
    await expect(call('orchestration.federationRelease', 'ctx_old')).resolves.toMatchObject({
      state: 'retained',
      reason: 'ownership_transferred',
      processAction: 'none'
    })
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it('durably retains a user-taken-over remote worker terminal', async () => {
    createAttachment('ctx_takeover', 'created')
    settleAttachment('ctx_takeover')

    const changed = (await call('orchestration.workerTerminalUserInput', 'ctx_takeover', {
      paneKey: PANE_KEY
    })) as { changed: number }

    expect(changed.changed).toBe(1)
    await expect(call('orchestration.federationRelease', 'ctx_takeover')).resolves.toMatchObject({
      state: 'retained',
      reason: 'user_takeover',
      processAction: 'none'
    })
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
  })

  // Host-owned evidence: the execution host certifies this PTY exited.
  function mockExitedRemoteTerminal(): void {
    vi.mocked(runtime.showTerminal).mockResolvedValue({
      handle: TERMINAL_HANDLE,
      worktreeId: 'repo::remote',
      connected: false,
      status: 'exited'
    } as never)
    vi.mocked(runtime.getTerminalLivenessVerdict).mockReturnValue({
      status: 'exited',
      ptyIds: [TERMINAL_HANDLE]
    } as never)
    vi.spyOn(runtime, 'readTerminal').mockResolvedValue({
      handle: TERMINAL_HANDLE,
      status: 'exited',
      tail: ['worker output'],
      truncated: false,
      entries: [{ cursor: 1, text: 'worker output' }],
      nextCursor: '1',
      limited: false
    } as never)
  }

  it('closes an exited remote terminal before reporting closed_exited_terminal', async () => {
    mockExitedRemoteTerminal()
    vi.mocked(runtime.closeTerminal).mockResolvedValue({
      handle: TERMINAL_HANDLE,
      tabId: 'tab-remote',
      ptyKilled: true
    } as never)
    createAttachment('ctx_exited', 'created')
    settleAttachment('ctx_exited')

    await expect(call('orchestration.federationRelease', 'ctx_exited')).resolves.toMatchObject({
      state: 'released',
      processAction: 'closed_exited_terminal'
    })
    expect(runtime.closeTerminal).toHaveBeenCalledWith(TERMINAL_HANDLE)
  })

  it.each([
    ['terminal_handle_stale', 'released'],
    ['endpoint is not connected', 'release_pending']
  ] as const)(
    'settles a host-certified exit whose close throws %s as %s',
    async (message, expected) => {
      mockExitedRemoteTerminal()
      vi.mocked(runtime.closeTerminal).mockRejectedValue(new Error(message))
      createAttachment(`ctx_throw_${expected}`, 'created')
      settleAttachment(`ctx_throw_${expected}`)

      await expect(
        call('orchestration.federationRelease', `ctx_throw_${expected}`)
      ).resolves.toMatchObject({ state: expected })
    }
  )

  it('fails closed for a settled legacy attachment without an ownership lease', async () => {
    createAttachment('ctx_legacy')
    settleAttachment('ctx_legacy')

    await expect(call('orchestration.federationRelease', 'ctx_legacy')).resolves.toMatchObject({
      state: 'retained',
      reason: 'no_owned_resource',
      processAction: 'none'
    })
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
  })

  function createAttachment(dispatchId: string, terminalOwnership?: 'created' | 'external'): void {
    db.createRemoteDispatchAttachment({
      dispatchId,
      taskId: `task_${dispatchId}`,
      homePeerFingerprint: HOME_FINGERPRINT,
      protocolVersion: ORCHESTRATION_CONTRACT_VERSION,
      runtimeEpoch: runtime.getRuntimeId(),
      mutationReceipt: {
        callerFingerprint: HOME_FINGERPRINT,
        requestId: `request_${dispatchId}`,
        method: 'orchestration.federationAttachStart',
        payloadHash: `hash_${dispatchId}`
      }
    })
    db.prepareRemoteAttachmentAuthority({
      dispatchId,
      paneKey: PANE_KEY,
      processIncarnation: PROCESS_INCARNATION,
      worktreeId: 'repo::remote',
      terminalHandle: TERMINAL_HANDLE,
      setupState: 'not_applicable',
      effects: [{ kind: 'terminal', action: 'created', id: TERMINAL_HANDLE }],
      ...(terminalOwnership ? { terminalOwnership } : {})
    })
    db.markRemoteAttachmentReady(dispatchId)
  }

  function settleAttachment(dispatchId: string): void {
    db.recordRemoteAttachmentStage({
      dispatchId,
      state: 'succeeded',
      stage: 'worker_reported'
    })
  }

  async function call(
    name: string,
    dispatchId: string,
    params: Record<string, unknown> = { dispatchId }
  ): Promise<unknown> {
    const method = ORCHESTRATION_METHODS.find((candidate) => candidate.name === name)
    if (!method) {
      throw new Error(`Method not found: ${name}`)
    }
    return method.handler(method.params!.parse(params), {
      runtime,
      authenticatedCallerFingerprint: HOME_FINGERPRINT
    } as never)
  }
})
