import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { OrchestrationDb } from '../orchestration/db'
import { OrcaRuntimeService } from '../orca-runtime'
import { RpcDispatcher } from './dispatcher'
import { ORCHESTRATION_METHODS } from './methods/orchestration'
import {
  cleanupLegacyCompatibilityDispatcherHarnesses,
  createHarness,
  currentEvidence,
  CURRENT_COORDINATOR_HANDLE,
  CURRENT_COORDINATOR_PANE,
  CURRENT_WORKER_HANDLE,
  CURRENT_WORKER_PANE,
  evidence,
  invoke,
  request,
  WORKER_HANDLE
} from './orchestration-legacy-compatibility-dispatcher-test-fixture'

const freshDatabases: OrchestrationDb[] = []

afterEach(() => {
  cleanupLegacyCompatibilityDispatcherHarnesses()
  for (const db of freshDatabases.splice(0)) {
    db.close()
  }
})

describe('Dispatch preamble capability recovery', () => {
  it.each(['dispatch', 'websocket'] as const)(
    '%s lets the exact assigned worker recover authority that settles once',
    async (transport) => {
      const harness = createHarness()
      const { taskId, dispatchId, originalCapability } = createCurrentDispatch(harness)
      const promptSend = vi.spyOn(harness.runtime, 'sendTerminalAgentPrompt')
      const rawSend = vi.spyOn(harness.runtime, 'sendTerminal')

      const recovered = await invoke(
        harness.dispatcher,
        request(
          'orchestration.dispatchShow',
          {
            task: taskId,
            preamble: true,
            recoverCapability: true,
            from: CURRENT_WORKER_HANDLE
          },
          currentEvidence('worker'),
          `recover-${transport}`
        ),
        transport
      )
      expect(recovered).toMatchObject({ ok: true, result: { dispatch: { id: dispatchId } } })
      const preamble = (recovered as { result: { preamble: string } }).result.preamble
      const capability = extractCapability(preamble)
      expect(preamble).toContain(`--from ${CURRENT_WORKER_HANDLE}`)
      expect(preamble).toContain(`coordinator's terminal handle is: ${CURRENT_COORDINATOR_HANDLE}`)
      expect(capability).toMatch(/^dcap_/)
      expect(capability).not.toBe(originalCapability)
      expect(promptSend).not.toHaveBeenCalled()
      expect(rawSend).not.toHaveBeenCalled()

      const completed = await harness.dispatcher.dispatch({
        ...request(
          'orchestration.send',
          {
            from: CURRENT_WORKER_HANDLE,
            type: 'worker_done',
            subject: 'Recovered completion',
            body: 'Recovered authority. Finished the work. Nothing remains.',
            payload: JSON.stringify({ taskId, dispatchId, outcome: 'succeeded' })
          },
          currentEvidence('worker'),
          `complete-${transport}`
        ),
        orchestrationCapability: capability
      })
      expect(completed).toMatchObject({
        ok: true,
        result: { lifecycle: { action: 'completed' } }
      })
      expect(harness.db.getTask(taskId)?.status).toBe('completed')
      expect(harness.db.getDispatchContextById(dispatchId)).toMatchObject({
        status: 'completed',
        capability_revoked_at: expect.any(String)
      })
    }
  )

  it('repeated recovery invalidates only the prior recovered capability', async () => {
    const harness = createHarness()
    const { taskId, dispatchId, originalCapability } = createCurrentDispatch(harness)

    const first = await harness.dispatcher.dispatch(
      request(
        'orchestration.dispatchShow',
        {
          task: taskId,
          preamble: true,
          recoverCapability: true,
          from: CURRENT_WORKER_HANDLE
        },
        currentEvidence('worker'),
        'first-worker-recovery'
      )
    )
    const firstCapability = extractCapability(
      (first as { result: { preamble: string } }).result.preamble
    )
    const second = await harness.dispatcher.dispatch(
      request(
        'orchestration.dispatchShow',
        {
          task: taskId,
          preamble: true,
          recoverCapability: true,
          from: CURRENT_WORKER_HANDLE
        },
        currentEvidence('worker'),
        'second-worker-recovery'
      )
    )
    const secondCapability = extractCapability(
      (second as { result: { preamble: string } }).result.preamble
    )
    expect(firstCapability).toMatch(/^dcap_/)
    expect(secondCapability).toMatch(/^dcap_/)
    expect(secondCapability).not.toBe(firstCapability)
    expect(
      harness.db.verifyDispatchCapability({
        dispatchId,
        capability: originalCapability,
        paneKey: CURRENT_WORKER_PANE,
        processIncarnation: 'process-1'
      }).valid
    ).toBe(false)
    expect(
      harness.db.verifyDispatchCapability({
        dispatchId,
        capability: firstCapability,
        paneKey: CURRENT_WORKER_PANE,
        processIncarnation: 'process-1'
      }).valid
    ).toBe(false)
    expect(
      harness.db.verifyDispatchCapability({
        dispatchId,
        capability: secondCapability,
        paneKey: CURRENT_WORKER_PANE,
        processIncarnation: 'process-1'
      }).valid
    ).toBe(true)
  })

  it.each(['dispatch', 'websocket'] as const)(
    '%s recovers on a fresh current-only database',
    async (transport) => {
      const harness = createFreshHarness()
      const { taskId, dispatchId } = createCurrentDispatch(harness)

      const response = await invoke(
        harness.dispatcher,
        request(
          'orchestration.dispatchShow',
          {
            task: taskId,
            preamble: true,
            recoverCapability: true,
            from: CURRENT_WORKER_HANDLE
          },
          currentEvidence('worker'),
          `fresh-recovery-${transport}`
        ),
        transport
      )

      expect(response.ok).toBe(true)
      expect(
        extractCapability((response as { result: { preamble: string } }).result.preamble)
      ).toMatch(/^dcap_/)
      expect(harness.db.getDispatchContextById(dispatchId)?.capability_hash).toMatch(/^[a-f0-9]+$/)
      expect(harness.db.getLegacyAdoption()).toBeUndefined()
    }
  )

  it('keeps ordinary fresh-database calls outside recovery authority preflights', async () => {
    const harness = createFreshHarness()
    const { taskId } = createCurrentDispatch(harness)
    const activeDispatchLookup = vi.spyOn(harness.db, 'getActiveDispatchForIdentity')
    const remoteAttachmentLookup = vi.spyOn(harness.db, 'findActiveRemoteAttachmentForPane')

    await harness.dispatcher.dispatch(
      request('orchestration.taskList', {}, currentEvidence('worker'), 'fresh-task-list')
    )
    await harness.dispatcher.dispatch(
      request(
        'orchestration.dispatchShow',
        { task: taskId, preamble: true, from: CURRENT_WORKER_HANDLE },
        currentEvidence('worker'),
        'fresh-dispatch-inspection'
      )
    )

    expect(activeDispatchLookup).not.toHaveBeenCalled()
    expect(remoteAttachmentLookup).not.toHaveBeenCalled()
  })

  it('keeps adopted-database Dispatch inspection outside recovery authority preflights', async () => {
    const harness = createHarness()
    const { taskId } = createCurrentDispatch(harness)
    const activeDispatchLookup = vi.spyOn(harness.db, 'getActiveDispatchForIdentity')
    const remoteAttachmentLookup = vi.spyOn(harness.db, 'findActiveRemoteAttachmentForPane')

    expect(harness.db.getLegacyAdoption()).toBeDefined()
    await harness.dispatcher.dispatch(
      request(
        'orchestration.dispatchShow',
        { task: taskId, preamble: true, from: CURRENT_WORKER_HANDLE },
        currentEvidence('worker'),
        'adopted-dispatch-inspection'
      )
    )

    expect(activeDispatchLookup).not.toHaveBeenCalled()
    expect(remoteAttachmentLookup).not.toHaveBeenCalled()
  })

  it('deduplicates one concurrent retry without persisting the recovered secret', async () => {
    const harness = createFreshHarness()
    const { taskId } = createCurrentDispatch(harness)
    const recover = vi.spyOn(harness.db, 'recoverDispatchCapability')
    const recoveryRequest = request(
      'orchestration.dispatchShow',
      {
        task: taskId,
        preamble: true,
        recoverCapability: true,
        from: CURRENT_WORKER_HANDLE
      },
      currentEvidence('worker'),
      'concurrent-recovery'
    )

    const [first, second] = await Promise.all([
      harness.dispatcher.dispatch(recoveryRequest),
      harness.dispatcher.dispatch(recoveryRequest)
    ])
    const firstCapability = extractCapability(
      (first as { result: { preamble: string } }).result.preamble
    )
    const secondCapability = extractCapability(
      (second as { result: { preamble: string } }).result.preamble
    )
    expect(firstCapability).toBe(secondCapability)
    expect(recover).toHaveBeenCalledOnce()
    expect(
      harness.db.getMutationReceipt(
        createHash('sha256').update('caller-token').digest('hex'),
        'concurrent-recovery'
      )
    ).toBeUndefined()
  })

  it('never shares an in-flight recovered secret with different caller evidence', async () => {
    const harness = createFreshHarness()
    const { taskId } = createCurrentDispatch(harness)
    const params = {
      task: taskId,
      preamble: true,
      recoverCapability: true,
      from: CURRENT_WORKER_HANDLE
    }

    const [authorized, spoofed] = await Promise.all([
      harness.dispatcher.dispatch(
        request(
          'orchestration.dispatchShow',
          params,
          currentEvidence('worker'),
          'cross-caller-recovery'
        )
      ),
      harness.dispatcher.dispatch(
        request(
          'orchestration.dispatchShow',
          params,
          currentEvidence('coordinator'),
          'cross-caller-recovery'
        )
      )
    ])

    expect(
      extractCapability((authorized as { result: { preamble: string } }).result.preamble)
    ).toMatch(/^dcap_/)
    expect((spoofed as { result: { preamble: string } }).result.preamble).not.toContain(
      '--dispatch-capability'
    )
  })

  it('never shares an in-flight recovered secret across host evidence', async () => {
    const harness = createFreshHarness()
    const { taskId } = createCurrentDispatch(harness)
    vi.mocked(harness.runtime.verifyOrchestrationCompatibilityCaller).mockImplementation(
      (callerEvidence) =>
        callerEvidence?.host?.kind === 'ssh' && callerEvidence.host.attachmentId === 'attached'
          ? {
              hostScope: { kind: 'ssh', targetId: 'target' },
              terminalHandle: CURRENT_WORKER_HANDLE,
              paneKey: CURRENT_WORKER_PANE,
              processIncarnation: 'process-1',
              launchTokenHash: 'worker-launch-hash'
            }
          : null
    )
    const params = {
      task: taskId,
      preamble: true,
      recoverCapability: true,
      from: CURRENT_WORKER_HANDLE
    }
    const validEvidence = {
      ...currentEvidence('worker'),
      host: {
        kind: 'ssh' as const,
        targetId: 'target',
        connectionIncarnation: 'connection',
        attachmentId: 'attached'
      }
    }
    const staleEvidence = {
      ...validEvidence,
      host: { ...validEvidence.host, attachmentId: 'stale' }
    }

    const [authorized, stale] = await Promise.all([
      harness.dispatcher.dispatch(
        request('orchestration.dispatchShow', params, validEvidence, 'cross-host-recovery')
      ),
      harness.dispatcher.dispatch(
        request('orchestration.dispatchShow', params, staleEvidence, 'cross-host-recovery')
      )
    ])

    expect(
      extractCapability((authorized as { result: { preamble: string } }).result.preamble)
    ).toMatch(/^dcap_/)
    expect((stale as { result: { preamble: string } }).result.preamble).not.toContain(
      '--dispatch-capability'
    )
  })

  it('deduplicates equivalent normalized caller evidence', async () => {
    const harness = createFreshHarness()
    const { taskId } = createCurrentDispatch(harness)
    const recover = vi.spyOn(harness.db, 'recoverDispatchCapability')
    const params = {
      task: taskId,
      preamble: true,
      recoverCapability: true,
      from: CURRENT_WORKER_HANDLE
    }
    const normalized = currentEvidence('worker')
    const padded = {
      terminalHandle: ` ${normalized.terminalHandle} `,
      paneKey: ` ${normalized.paneKey} `,
      launchToken: ` ${normalized.launchToken} `
    }

    const [first, second] = await Promise.all([
      harness.dispatcher.dispatch(
        request('orchestration.dispatchShow', params, normalized, 'normalized-recovery')
      ),
      harness.dispatcher.dispatch(
        request('orchestration.dispatchShow', params, padded, 'normalized-recovery')
      )
    ])

    expect(extractCapability((first as { result: { preamble: string } }).result.preamble)).toBe(
      extractCapability((second as { result: { preamble: string } }).result.preamble)
    )
    expect(recover).toHaveBeenCalledOnce()
  })

  it('reports unavailable recovery for the apparent assignee without attestation', async () => {
    const harness = createFreshHarness()
    const { taskId } = createCurrentDispatch(harness)

    const response = await harness.dispatcher.dispatch({
      ...request(
        'orchestration.dispatchShow',
        {
          task: taskId,
          preamble: true,
          recoverCapability: true,
          from: CURRENT_WORKER_HANDLE
        },
        currentEvidence('worker'),
        'missing-attestation-recovery'
      ),
      orchestrationCompatibilityEvidence: undefined
    })

    expect(response).toMatchObject({ ok: true, result: { recovery: 'unavailable' } })
    expect((response as { result: { preamble: string } }).result.preamble).not.toContain(
      '--dispatch-capability'
    )
  })

  it('preserves existing authority when CLI-command resolution fails', async () => {
    const harness = createFreshHarness()
    const { taskId, dispatchId, originalCapability } = createCurrentDispatch(harness)
    const recover = vi.spyOn(harness.db, 'recoverDispatchCapability')
    vi.mocked(harness.runtime.getTerminalOrchestrationCliCommand).mockImplementation(() => {
      throw new Error('cli command unavailable')
    })

    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.dispatchShow',
        {
          task: taskId,
          preamble: true,
          recoverCapability: true,
          from: CURRENT_WORKER_HANDLE
        },
        currentEvidence('worker'),
        'cli-resolution-failure'
      )
    )

    expect(response).toMatchObject({ ok: false, error: { message: 'cli command unavailable' } })
    expect(recover).not.toHaveBeenCalled()
    expect(
      harness.db.verifyDispatchCapability({
        dispatchId,
        capability: originalCapability,
        paneKey: CURRENT_WORKER_PANE,
        processIncarnation: 'process-1'
      }).valid
    ).toBe(true)
  })

  it('recovers and settles after the assigned handle is reminted', async () => {
    const harness = createFreshHarness()
    const { taskId, dispatchId } = createCurrentDispatch(harness)
    const remintedHandle = 'term_worker_reminted'
    vi.mocked(harness.runtime.verifyOrchestrationCompatibilityCaller).mockReturnValue({
      hostScope: { kind: 'local', hostId: 'local' },
      terminalHandle: remintedHandle,
      paneKey: CURRENT_WORKER_PANE,
      processIncarnation: 'process-1',
      launchTokenHash: 'reminted-launch-hash'
    })
    const remintedEvidence = {
      terminalHandle: remintedHandle,
      paneKey: CURRENT_WORKER_PANE,
      launchToken: 'reminted-launch-token'
    }

    const recovered = await harness.dispatcher.dispatch(
      request(
        'orchestration.dispatchShow',
        {
          task: taskId,
          preamble: true,
          recoverCapability: true,
          from: remintedHandle
        },
        remintedEvidence,
        'reminted-recovery'
      )
    )
    const preamble = (recovered as { result: { preamble: string } }).result.preamble
    const capability = extractCapability(preamble)
    expect(preamble).toContain(`--from ${remintedHandle}`)
    expect(harness.runtime.getTerminalOrchestrationCliCommand).toHaveBeenCalledWith(remintedHandle)

    const completed = await harness.dispatcher.dispatch({
      ...request(
        'orchestration.send',
        {
          from: remintedHandle,
          type: 'worker_done',
          subject: 'Reminted completion',
          body: 'Recovered after remint. Finished the work. Nothing remains.',
          payload: JSON.stringify({ taskId, dispatchId, outcome: 'succeeded' })
        },
        remintedEvidence,
        'reminted-completion'
      ),
      orchestrationCapability: capability
    })
    expect(completed).toMatchObject({
      ok: true,
      result: { lifecycle: { action: 'completed' } }
    })
  })

  it('rejects capability rotation by the bound coordinator', async () => {
    const harness = createHarness()
    const { taskId, dispatchId, originalCapability } = createCurrentDispatch(harness)

    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.dispatchShow',
        {
          task: taskId,
          preamble: true,
          recoverCapability: true,
          from: CURRENT_COORDINATOR_HANDLE
        },
        currentEvidence('coordinator'),
        'coordinator-recovery'
      )
    )
    expect(response.ok).toBe(true)
    expect(response).toMatchObject({ result: { recovery: 'inspection' } })
    expect((response as { result: { preamble: string } }).result.preamble).not.toContain(
      '--dispatch-capability'
    )
    expect(
      harness.db.verifyDispatchCapability({
        dispatchId,
        capability: originalCapability,
        paneKey: CURRENT_WORKER_PANE,
        processIncarnation: 'process-1'
      }).valid
    ).toBe(true)
  })

  it('does not rotate authority for a claimed handle that disagrees with attestation', async () => {
    const harness = createHarness()
    const { taskId, dispatchId, originalCapability } = createCurrentDispatch(harness)
    const recover = vi.spyOn(harness.db, 'recoverDispatchCapability')

    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.dispatchShow',
        {
          task: taskId,
          preamble: true,
          recoverCapability: true,
          from: CURRENT_COORDINATOR_HANDLE
        },
        currentEvidence('worker'),
        'spoofed-recovery'
      )
    )
    expect(response.ok).toBe(true)
    expect((response as { result: { preamble: string } }).result.preamble).not.toContain(
      '--dispatch-capability'
    )
    expect(recover).not.toHaveBeenCalled()
    expect(
      harness.db.verifyDispatchCapability({
        dispatchId,
        capability: originalCapability,
        paneKey: CURRENT_WORKER_PANE,
        processIncarnation: 'process-1'
      }).valid
    ).toBe(true)
  })

  it('rejects recovery after the assigned process incarnation changes', async () => {
    const harness = createHarness()
    const { taskId, dispatchId, originalCapability } = createCurrentDispatch(harness, 'process-2')

    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.dispatchShow',
        {
          task: taskId,
          preamble: true,
          recoverCapability: true,
          from: CURRENT_WORKER_HANDLE
        },
        currentEvidence('worker'),
        'stale-process-recovery'
      )
    )
    expect(response.ok).toBe(true)
    expect((response as { result: { preamble: string } }).result.preamble).not.toContain(
      '--dispatch-capability'
    )
    expect(
      harness.db.verifyDispatchCapability({
        dispatchId,
        capability: originalCapability,
        paneKey: CURRENT_WORKER_PANE,
        processIncarnation: 'process-2'
      }).valid
    ).toBe(true)
  })

  it('does not rotate pending or start-unknown supervised authority', () => {
    const harness = createFreshHarness()
    const { dispatchId, originalCapability } = createStartingDispatch(harness.db)

    expect(() =>
      harness.db.recoverDispatchCapability({
        dispatchId,
        callerPaneKey: CURRENT_WORKER_PANE,
        callerProcessIncarnation: 'process-1'
      })
    ).toThrow('not an active current-contract Dispatch')
    harness.db.markWorkerStartUnknown(dispatchId, 'input_unknown', 'write outcome unknown')
    expect(() =>
      harness.db.recoverDispatchCapability({
        dispatchId,
        callerPaneKey: CURRENT_WORKER_PANE,
        callerProcessIncarnation: 'process-1'
      })
    ).toThrow('not an active current-contract Dispatch')
    expect(
      harness.db.verifyDispatchCapability({
        dispatchId,
        capability: originalCapability,
        paneKey: CURRENT_WORKER_PANE,
        processIncarnation: 'process-1'
      }).valid
    ).toBe(false)
  })

  it('does not rotate revoked or stopping authority', () => {
    const revokedHarness = createFreshHarness()
    const revoked = createCurrentDispatch(revokedHarness)
    revokedHarness.db.revokeDispatchCapability(revoked.dispatchId)
    expect(() =>
      revokedHarness.db.recoverDispatchCapability({
        dispatchId: revoked.dispatchId,
        callerPaneKey: CURRENT_WORKER_PANE,
        callerProcessIncarnation: 'process-1'
      })
    ).toThrow('not an active current-contract Dispatch')

    const stoppingHarness = createFreshHarness()
    const stopping = createStartingDispatch(stoppingHarness.db)
    stoppingHarness.db.markWorkerDispatchReady(stopping.dispatchId)
    stoppingHarness.db.beginWorkerStop(stopping.dispatchId)
    expect(() =>
      stoppingHarness.db.recoverDispatchCapability({
        dispatchId: stopping.dispatchId,
        callerPaneKey: CURRENT_WORKER_PANE,
        callerProcessIncarnation: 'process-1'
      })
    ).toThrow('not an active current-contract Dispatch')
  })

  it('keeps legacy Dispatch preamble inspection tokenless and non-mutating', async () => {
    const harness = createHarness()
    const recover = vi.spyOn(harness.db, 'recoverDispatchCapability')

    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.dispatchShow',
        {
          task: harness.taskId,
          preamble: true,
          recoverCapability: true,
          from: WORKER_HANDLE
        },
        evidence('worker'),
        'legacy-dispatch-inspection'
      )
    )
    expect(response.ok).toBe(true)
    expect((response as { result: { preamble: string } }).result.preamble).not.toContain(
      '--dispatch-capability'
    )
    expect(recover).not.toHaveBeenCalled()
  })
})

function createCurrentDispatch(
  harness: { db: OrchestrationDb },
  processIncarnation = 'process-1'
): { taskId: string; dispatchId: string; originalCapability: string } {
  const run = harness.db.createRun({
    objective: 'current recovery',
    coordinatorHandle: CURRENT_COORDINATOR_HANDLE,
    coordinatorPaneKey: CURRENT_COORDINATOR_PANE
  })
  const task = harness.db.createTask({ spec: 'finish recovered work', runId: run.id })
  const dispatch = harness.db.createDispatchContext(
    task.id,
    CURRENT_WORKER_HANDLE,
    CURRENT_WORKER_PANE,
    undefined,
    processIncarnation
  )
  const originalCapability = harness.db.mintDispatchCapability({
    dispatchId: dispatch.id,
    paneKey: CURRENT_WORKER_PANE,
    processIncarnation
  })
  return { taskId: task.id, dispatchId: dispatch.id, originalCapability }
}

function extractCapability(preamble: string): string | undefined {
  return preamble.match(/--dispatch-capability (dcap_[A-Za-z0-9_-]+)/)?.[1]
}

function createStartingDispatch(db: OrchestrationDb): {
  dispatchId: string
  originalCapability: string
} {
  const run = db.createRun({
    objective: 'supervised recovery state',
    coordinatorHandle: CURRENT_COORDINATOR_HANDLE,
    coordinatorPaneKey: CURRENT_COORDINATOR_PANE
  })
  const task = db.createTask({ spec: 'supervised assignment', runId: run.id })
  const dispatch = db.createStartingWorkerDispatch({ taskId: task.id, startOptions: {} }).dispatch
  const originalCapability = db.prepareStartingWorkerAuthority({
    dispatchId: dispatch.id,
    handle: CURRENT_WORKER_HANDLE,
    paneKey: CURRENT_WORKER_PANE,
    processIncarnation: 'process-1',
    worktreeId: 'id:repo::worktree',
    effects: [],
    setupState: 'not_required'
  })
  return { dispatchId: dispatch.id, originalCapability }
}

function createFreshHarness(): {
  db: OrchestrationDb
  runtime: OrcaRuntimeService
  dispatcher: RpcDispatcher
} {
  const db = new OrchestrationDb(':memory:')
  freshDatabases.push(db)
  const runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(db)
  vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockReturnValue({
    hostScope: { kind: 'local', hostId: 'local' },
    terminalHandle: CURRENT_WORKER_HANDLE,
    paneKey: CURRENT_WORKER_PANE,
    processIncarnation: 'process-1',
    launchTokenHash: 'worker-launch-hash'
  })
  vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
  vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue(CURRENT_WORKER_PANE)
  vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue('process-1')
  return {
    db,
    runtime,
    dispatcher: new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
  }
}
