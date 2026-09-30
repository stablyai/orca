import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../../../shared/protocol-version'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db'
import { requireMailboxConsumer } from '../../../../orchestration/db/messages/mailbox-consumer'
import { ORCHESTRATION_METHODS } from '../../orchestration'
import { eraseRpcMethods } from '../../../core'

const HOME = 'home-peer-fingerprint'
const DISPATCH_ID = 'ctx_reconcile_attachment'
const HANDLE = 'term_retained_native'
const PANE = 'tab_retained:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const INCARNATION = 'runtime:pty:retained'

describe('abandoned remote attachment reconcile', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let capability: string
  let closeTerminal: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue(PANE)
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue(INCARNATION)
    vi.spyOn(runtime, 'getTerminalLivenessVerdict').mockReturnValue({ status: 'live' })
    vi.spyOn(runtime, 'showTerminal').mockResolvedValue({
      handle: HANDLE,
      connected: true
    } as never)
    closeTerminal = vi.spyOn(runtime, 'closeTerminal')
    db.createRemoteDispatchAttachment({
      runId: 'run-home',
      dispatchId: DISPATCH_ID,
      taskId: 'task_remote',
      homePeerFingerprint: HOME,
      protocolVersion: ORCHESTRATION_CONTRACT_VERSION,
      runtimeEpoch: runtime.getRuntimeId(),
      mutationReceipt: {
        callerFingerprint: HOME,
        requestId: 'rpc_attach',
        method: 'orchestration.federationAttachStart',
        payloadHash: 'hash'
      }
    })
    capability = db.prepareRemoteAttachmentAuthority({
      dispatchId: DISPATCH_ID,
      paneKey: PANE,
      processIncarnation: INCARNATION,
      worktreeId: 'repo::retained',
      terminalHandle: HANDLE,
      setupState: 'not_applicable',
      effects: [],
      terminalOwnership: 'created'
    })
    db.markRemoteAttachmentReady(DISPATCH_ID)
    db.db
      .prepare(
        `INSERT INTO deliveries (id, run_id, mailbox_handle, consumer_generation, message_ids, status)
         VALUES ('delivery_old', 'run-home', ?, 1, '[]', 'outstanding')`
      )
      .run(`dispatch:${DISPATCH_ID}`)
  })

  afterEach(() => db.close())

  async function call(params: Record<string, unknown>, fingerprint = HOME) {
    const method = eraseRpcMethods(ORCHESTRATION_METHODS).find(
      (candidate) => candidate.name === 'orchestration.federationReconcileAttachment'
    )
    if (!method) {
      throw new Error('reconcile method missing')
    }
    return method.handler(method.params!.parse(params), {
      runtime,
      authenticatedCallerFingerprint: fingerprint
    } as never)
  }

  function expectedParams(overrides: Record<string, string> = {}) {
    return {
      dispatchId: DISPATCH_ID,
      expectedRuntimeEpoch: runtime.getRuntimeId(),
      expectedTerminalHandle: HANDLE,
      expectedPaneKey: PANE,
      expectedProcessIncarnation: INCARNATION,
      ...overrides
    }
  }

  function resourceRows(): string {
    return JSON.stringify(
      db.db.prepare('SELECT * FROM worker_terminal_resources ORDER BY id').all()
    )
  }

  it('retires the exact attachment and leaves the terminal and resource rows untouched', async () => {
    const beforeGeneration = db.getRemoteDispatchAttachment(DISPATCH_ID)?.consumer_generation
    const beforeResources = resourceRows()

    const receipt = await call(expectedParams())

    expect(receipt).toEqual({
      dispatchId: DISPATCH_ID,
      state: 'abandoned',
      alreadyReconciled: false,
      processAction: 'none'
    })
    expect(closeTerminal).not.toHaveBeenCalled()
    expect(resourceRows()).toBe(beforeResources)
    const attachment = db.getRemoteDispatchAttachment(DISPATCH_ID)
    expect(attachment).toMatchObject({
      state: 'abandoned',
      stage: 'attachment_reconciled',
      capability_hash: null,
      terminal_handle: HANDLE,
      process_incarnation: INCARNATION
    })
    expect(attachment?.consumer_generation).toBe((beforeGeneration ?? 0) + 1)
    expect(
      db.verifyRemoteAttachmentAuthority({
        dispatchId: DISPATCH_ID,
        capability,
        paneKey: PANE,
        processIncarnation: INCARNATION
      })
    ).toBe(false)
    expect(() =>
      requireMailboxConsumer(db, {
        runId: 'run-home',
        mailboxHandle: `dispatch:${DISPATCH_ID}`,
        consumerGeneration: beforeGeneration ?? 0,
        consumerSource: 'attachment'
      })
    ).toThrowError(expect.objectContaining({ code: 'consumer_fenced' }))
    expect(
      db.db.prepare('SELECT status FROM deliveries WHERE id = ?').get('delivery_old')
    ).toEqual({ status: 'fenced' })
    expect(db.findActiveRemoteAttachmentForPane(PANE)).toBeUndefined()
  })

  it('does not bump generation or close anything when the same request is repeated', async () => {
    await call(expectedParams())
    const generation = db.getRemoteDispatchAttachment(DISPATCH_ID)?.consumer_generation
    const resources = resourceRows()
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue('runtime:pty:reused')
    vi.spyOn(runtime, 'getTerminalLivenessVerdict').mockReturnValue({ status: 'exited' })

    await expect(call(expectedParams())).resolves.toMatchObject({
      alreadyReconciled: true,
      processAction: 'none'
    })

    expect(db.getRemoteDispatchAttachment(DISPATCH_ID)?.consumer_generation).toBe(generation)
    expect(resourceRows()).toBe(resources)
    expect(closeTerminal).not.toHaveBeenCalled()
  })

  it('refuses a changed incarnation without a write or a process action', async () => {
    const before = JSON.stringify(db.getRemoteDispatchAttachment(DISPATCH_ID))
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue('runtime:pty:replacement')

    await expect(call(expectedParams())).rejects.toMatchObject({ code: 'worker_identity_changed' })

    expect(JSON.stringify(db.getRemoteDispatchAttachment(DISPATCH_ID))).toBe(before)
    expect(closeTerminal).not.toHaveBeenCalled()
  })

  it('does not treat a missing verdict as live after the initial observation', async () => {
    const before = JSON.stringify(db.getRemoteDispatchAttachment(DISPATCH_ID))
    vi.spyOn(runtime, 'getTerminalLivenessVerdict')
      .mockReturnValueOnce({ status: 'live' })
      .mockReturnValue(null)

    await expect(call(expectedParams())).rejects.toMatchObject({ code: 'unverifiable' })

    expect(JSON.stringify(db.getRemoteDispatchAttachment(DISPATCH_ID))).toBe(before)
    expect(closeTerminal).not.toHaveBeenCalled()
  })

  it('refuses unverifiable contact without a write', async () => {
    const before = JSON.stringify(db.getRemoteDispatchAttachment(DISPATCH_ID))
    vi.spyOn(runtime, 'getTerminalLivenessVerdict').mockReturnValue({
      status: 'unverifiable',
      reason: 'ssh_provider_gone'
    })

    await expect(call(expectedParams())).rejects.toMatchObject({ code: 'unverifiable' })

    expect(JSON.stringify(db.getRemoteDispatchAttachment(DISPATCH_ID))).toBe(before)
    expect(closeTerminal).not.toHaveBeenCalled()
  })

  it('keeps a transferred resource byte-for-byte unchanged', async () => {
    db.createWorkerTerminalResourceStatement({
      dispatchId: 'ctx_other_owner',
      worktreeId: 'repo::retained',
      terminalHandle: HANDLE,
      paneKey: PANE,
      processIncarnation: INCARNATION,
      ownership: 'owned'
    })
    const before = resourceRows()

    await call(expectedParams())

    expect(resourceRows()).toBe(before)
    expect(closeTerminal).not.toHaveBeenCalled()
  })

  it('reconciles a folder workspace attachment without closing its terminal', async () => {
    db.db
      .prepare('UPDATE remote_dispatch_attachments SET worktree_id = ? WHERE dispatch_id = ?')
      .run('folder-workspace:group-1', DISPATCH_ID)
    const before = resourceRows()

    await expect(call(expectedParams())).resolves.toMatchObject({
      processAction: 'none',
      state: 'abandoned'
    })

    expect(db.getRemoteDispatchAttachment(DISPATCH_ID)?.worktree_id).toBe(
      'folder-workspace:group-1'
    )
    expect(resourceRows()).toBe(before)
    expect(closeTerminal).not.toHaveBeenCalled()
  })

  it('allows a later attachment of the same preserved terminal', async () => {
    await call(expectedParams())
    db.createRemoteDispatchAttachment({
      runId: 'run-home',
      dispatchId: 'ctx_next',
      taskId: 'task_next',
      homePeerFingerprint: HOME,
      protocolVersion: ORCHESTRATION_CONTRACT_VERSION,
      runtimeEpoch: runtime.getRuntimeId(),
      mutationReceipt: {
        callerFingerprint: HOME,
        requestId: 'rpc_next',
        method: 'orchestration.federationAttachStart',
        payloadHash: 'hash-next'
      }
    })

    expect(() =>
      db.prepareRemoteAttachmentAuthority({
        dispatchId: 'ctx_next',
        paneKey: PANE,
        processIncarnation: INCARNATION,
        worktreeId: 'repo::retained',
        terminalHandle: HANDLE,
        setupState: 'not_applicable',
        effects: [],
        terminalOwnership: 'external'
      })
    ).not.toThrow()
    expect(db.getRemoteDispatchAttachment('ctx_next')?.terminal_handle).toBe(HANDLE)
    expect(closeTerminal).not.toHaveBeenCalled()
  })

  it('rolls back when the process incarnation changes inside the write', () => {
    const before = JSON.stringify(db.getRemoteDispatchAttachment(DISPATCH_ID))

    expect(() =>
      db.reconcileAbandonedRemoteAttachment({
        dispatchId: DISPATCH_ID,
        homePeerFingerprint: HOME,
        expectedRuntimeEpoch: runtime.getRuntimeId(),
        currentRuntimeEpoch: runtime.getRuntimeId(),
        expectedTerminalHandle: HANDLE,
        expectedPaneKey: PANE,
        expectedProcessIncarnation: INCARNATION,
        rereadObserved: () => ({
          paneKey: PANE,
          processIncarnation: 'runtime:pty:replacement',
          unverifiable: false
        })
      })
    ).toThrowError(expect.objectContaining({ code: 'worker_identity_changed' }))

    expect(JSON.stringify(db.getRemoteDispatchAttachment(DISPATCH_ID))).toBe(before)
  })

  it('does not reconcile a different home or a mismatched epoch', async () => {
    const before = JSON.stringify(db.getRemoteDispatchAttachment(DISPATCH_ID))

    await expect(call(expectedParams(), 'other-home')).rejects.toMatchObject({
      code: 'dispatch_not_found'
    })
    await expect(
      call(expectedParams({ expectedRuntimeEpoch: 'epoch-old' }))
    ).rejects.toMatchObject({ code: 'runtime_epoch_mismatch' })

    expect(JSON.stringify(db.getRemoteDispatchAttachment(DISPATCH_ID))).toBe(before)
    expect(closeTerminal).not.toHaveBeenCalled()
  })
})
