import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'

describe('release of the original missing process without an archive', () => {
  const harness = createOrchestrationWorkerReleaseHarness()
  beforeEach(() => {
    harness.setup()
    vi.spyOn(harness.runtime, 'resolveTerminalHandleByProcessIncarnation').mockReturnValue(null)
  })
  afterEach(() => harness.cleanup())

  async function startMissingWorker(outcome: 'succeeded' | 'failed' = 'succeeded') {
    const worker = await harness.startSettledWorker(outcome)
    vi.mocked(harness.runtime.showTerminal).mockRejectedValue(new Error('terminal_handle_stale'))
    return worker
  }

  it.each(['succeeded', 'failed'] as const)(
    'settles %s with truthful unavailable output',
    async (outcome) => {
      const { dispatchId } = await startMissingWorker(outcome)
      harness.inspectProcessLiveness.mockResolvedValue('exited')
      const receipt = await harness.call('orchestration.workerRelease', { dispatch: dispatchId })
      expect(receipt).toMatchObject({
        state: 'released',
        processAction: 'none',
        archive: { status: 'unavailable' }
      })
      expect(harness.db.getWorkerTerminalArchive(dispatchId)).toBeUndefined()
      const resource = harness.db.getWorkerTerminalResourceByOwner(dispatchId)
      expect(resource).toMatchObject({
        ownership_state: 'released',
        release_state: 'released',
        archive_status: 'unavailable',
        release_error: null
      })
      expect(resource?.release_completed_at).toBeTruthy()
      expect(
        await harness.call('orchestration.workerRelease', { dispatch: dispatchId })
      ).toMatchObject({ state: 'already_released', archive: { status: 'unavailable' } })
      expect(harness.runtime.closeTerminal).not.toHaveBeenCalled()
    }
  )

  it.each(['live', 'unverifiable'])(
    'preserves unknown output while process is %s',
    async (liveness) => {
      const { dispatchId } = await startMissingWorker()
      harness.inspectProcessLiveness.mockResolvedValue(liveness)
      expect(
        await harness.call('orchestration.workerRelease', { dispatch: dispatchId })
      ).toMatchObject({ state: 'release_unknown' })
      expect(
        harness.db.getWorkerTerminalResourceByOwner(dispatchId)?.release_completed_at
      ).toBeNull()
    }
  )

  it('allows a fresh release after an unknown result once death is proved', async () => {
    const { dispatchId } = await startMissingWorker()
    expect(
      await harness.call('orchestration.workerRelease', { dispatch: dispatchId })
    ).toMatchObject({ state: 'release_unknown' })
    harness.inspectProcessLiveness.mockResolvedValue('exited')
    expect(
      await harness.call('orchestration.workerRelease', { dispatch: dispatchId })
    ).toMatchObject({ state: 'released', archive: { status: 'unavailable' } })
  })

  it('honors retention arriving while the process probe is pending', async () => {
    const { dispatchId } = await startMissingWorker()
    const probe = harness.deferred<string>()
    const entered = harness.deferred<void>()
    harness.inspectProcessLiveness.mockImplementation(() => {
      entered.resolve()
      return probe.promise
    })
    const release = harness.call('orchestration.workerRelease', { dispatch: dispatchId })
    await entered.promise
    await harness.call('orchestration.workerRetain', { dispatch: dispatchId })
    probe.resolve('exited')
    expect(await release).toMatchObject({ state: 'retained', reason: 'user_requested' })
    expect(harness.db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      release_state: 'retained',
      release_completed_at: null
    })
  })

  it.each(['user_owned', 'transferred', 'external'] as const)(
    'protects a concurrent ownership change to %s',
    async (ownership) => {
      const { dispatchId } = await startMissingWorker()
      const resource = harness.db.getWorkerTerminalResourceByOwner(dispatchId)!
      harness.inspectProcessLiveness.mockImplementation(async () => {
        harness.db.db
          .prepare('UPDATE worker_terminal_resources SET ownership_state = ? WHERE id = ?')
          .run(ownership, resource.id)
        return 'exited'
      })
      expect(
        await harness.call('orchestration.workerRelease', { dispatch: dispatchId })
      ).toMatchObject({ state: 'retained' })
      expect(harness.db.getWorkerTerminalResource(resource.id)?.release_completed_at).toBeNull()
    }
  )

  it('protects a reminted handle that appears during the death probe', async () => {
    const { dispatchId } = await startMissingWorker()
    harness.inspectProcessLiveness.mockImplementation(async () => {
      vi.mocked(harness.runtime.resolveTerminalHandleByProcessIncarnation).mockReturnValue(
        'term_reminted'
      )
      return 'exited'
    })
    expect(
      await harness.call('orchestration.workerRelease', { dispatch: dispatchId })
    ).toMatchObject({ state: 'release_unknown' })
    expect(harness.runtime.closeTerminal).not.toHaveBeenCalled()
    expect(harness.db.getWorkerTerminalResourceByOwner(dispatchId)?.release_completed_at).toBeNull()
  })

  it.each(['process_incarnation', 'host_scope', 'terminal_handle'] as const)(
    'protects %s replaced during the death probe',
    async (column) => {
      const { dispatchId } = await startMissingWorker()
      const resource = harness.db.getWorkerTerminalResourceByOwner(dispatchId)!
      harness.inspectProcessLiveness.mockImplementation(async () => {
        harness.db.db
          .prepare(`UPDATE worker_terminal_resources SET ${column} = ? WHERE id = ?`)
          .run('replacement', resource.id)
        return 'exited'
      })
      expect(
        await harness.call('orchestration.workerRelease', { dispatch: dispatchId })
      ).toMatchObject({
        state: 'release_pending',
        recovery: expect.stringContaining('recovery will retry')
      })
      expect(harness.db.getWorkerTerminalResource(resource.id)?.release_completed_at).toBeNull()
    }
  )

  it.each(['process_incarnation', 'host_scope', 'terminal_handle'] as const)(
    'reports unknown when %s changes and the current release is already unknown',
    async (column) => {
      const { dispatchId } = await startMissingWorker()
      const resource = harness.db.getWorkerTerminalResourceByOwner(dispatchId)!
      harness.inspectProcessLiveness.mockImplementation(async () => {
        harness.db.db
          .prepare(
            `UPDATE worker_terminal_resources
             SET ${column} = ?, release_state = 'unknown', release_error = ?
             WHERE id = ?`
          )
          .run('replacement', 'close outcome was not proven', resource.id)
        return 'exited'
      })
      expect(
        await harness.call('orchestration.workerRelease', { dispatch: dispatchId })
      ).toMatchObject({
        state: 'release_unknown',
        lastError: 'close outcome was not proven',
        recovery: expect.stringContaining('fresh request ID')
      })
      expect(harness.db.getWorkerTerminalResource(resource.id)).toMatchObject({
        release_state: 'unknown',
        release_completed_at: null
      })
    }
  )

  it('preserves an already released row when the death probe races with settlement', async () => {
    const { dispatchId } = await startMissingWorker()
    const resource = harness.db.getWorkerTerminalResourceByOwner(dispatchId)!
    harness.inspectProcessLiveness.mockImplementation(async () => {
      harness.db.db
        .prepare(
          `UPDATE worker_terminal_resources
           SET ownership_state = 'released', release_state = 'released',
               release_completed_at = datetime('now')
           WHERE id = ?`
        )
        .run(resource.id)
      return 'exited'
    })
    expect(
      await harness.call('orchestration.workerRelease', { dispatch: dispatchId })
    ).toMatchObject({ state: 'already_released' })
  })
})
