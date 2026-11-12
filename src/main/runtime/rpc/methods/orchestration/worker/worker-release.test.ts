import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'

describe('orchestration worker release', () => {
  const h = createOrchestrationWorkerReleaseHarness()

  afterEach(() => h.cleanup())

  it('is idempotent: a duplicate release returns already_released without another close', async () => {
    h.setup()
    const { dispatchId } = await h.startSettledWorker()
    await h.call('orchestration.workerRelease', { dispatch: dispatchId })
    const second = (await h.call('orchestration.workerRelease', { dispatch: dispatchId })) as {
      state: string
      processAction: string
    }
    expect(second).toMatchObject({ state: 'already_released', processAction: 'none' })
    expect(h.runtime.closeTerminal).toHaveBeenCalledTimes(1)
  })

  it('retains a dead external terminal the orchestration never owned', async () => {
    h.setup()
    const { dispatchId } = await h.startSettledWorker('succeeded', { terminal: 'term_worker' })
    h.inspectProcessLiveness.mockResolvedValue('exited')

    await expect(
      h.call('orchestration.workerRelease', { dispatch: dispatchId })
    ).resolves.toMatchObject({
      state: 'retained',
      reason: 'external_terminal',
      processAction: 'none'
    })
    expect(h.inspectProcessLiveness).toHaveBeenCalledWith(
      'runtime_test:term_worker:1',
      JSON.stringify({ kind: 'local', hostId: 'local' })
    )
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
    expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      ownership_state: 'external',
      release_state: 'not_requested'
    })
  })

  it.each([false, true])(
    'keeps the output reference of a stopped worker (retained first: %s)',
    async (retain) => {
      h.setup()
      const { dispatchId } = await h.startWorker()
      await expect(
        h.call('orchestration.workerStop', { dispatch: dispatchId })
      ).resolves.toMatchObject({ state: 'stopped' })
      if (retain) {
        await h.call('orchestration.workerRetain', { dispatch: dispatchId })
      }
      h.inspectProcessLiveness.mockResolvedValue('exited')

      await expect(
        h.call('orchestration.workerRelease', { dispatch: dispatchId })
      ).resolves.toMatchObject({ state: 'released', archive: { status: 'unavailable' } })
      expect(h.db.getWorkerTerminalArchive(dispatchId)?.kind).toBe('terminal_tail')
    }
  )

  it('does not claim retention succeeded after terminal close was committed', async () => {
    h.setup()
    const { dispatchId } = await h.startSettledWorker()
    const pendingClose = h.deferred<Awaited<ReturnType<OrcaRuntimeService['closeTerminal']>>>()
    vi.mocked(h.runtime.closeTerminal).mockReturnValue(pendingClose.promise)

    const release = h.call('orchestration.workerRelease', { dispatch: dispatchId })
    await vi.waitFor(() => expect(h.runtime.closeTerminal).toHaveBeenCalledTimes(1))
    await expect(
      h.call('orchestration.workerRetain', { dispatch: dispatchId })
    ).resolves.toMatchObject({ state: 'release_pending' })
    expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('releasing')
    pendingClose.resolve({ handle: 'term_worker', tabId: 'tab-worker', ptyKilled: true })

    await expect(release).resolves.toMatchObject({ state: 'released' })
    expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('released')
  })

  it('keeps a resumed settled worker retained in worker-list without re-dispatch or release', async () => {
    h.setup()
    const { dispatchId, taskId } = await h.startSettledWorker()
    const dispatch = h.db.getDispatchContextById(dispatchId)
    const task = h.db.getTask(taskId)
    vi.mocked(h.runtime.createTerminal).mockClear()
    vi.mocked(h.runtime.sendTerminalAgentPrompt).mockClear()
    vi.mocked(h.runtime.getTerminalProcessIncarnation).mockImplementation((handle) =>
      handle === 'term_worker' ? 'runtime_test:term_worker:2' : null
    )

    await expect(
      h.call('orchestration.workerRelease', { dispatch: dispatchId })
    ).resolves.toMatchObject({
      state: 'retained',
      reason: 'identity_unproven',
      processAction: 'none'
    })
    const listed = (await h.call('orchestration.workerList', { run: h.activeRunId })) as {
      workers: { dispatchId: string; terminalState: string; workerState: string }[]
    }
    expect(listed.workers).toEqual([
      expect.objectContaining({ dispatchId, terminalState: 'retained', workerState: 'succeeded' })
    ])
    expect(h.db.getTask(taskId)).toEqual(task)
    expect(h.db.getDispatchContextById(dispatchId)).toEqual(dispatch)
    expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('retained')
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
    expect(h.runtime.createTerminal).not.toHaveBeenCalled()
    expect(h.runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })

  it('returns release_unknown when the terminal no longer resolves, then completes a retry', async () => {
    h.setup()
    const { dispatchId } = await h.startSettledWorker()
    vi.mocked(h.runtime.showTerminal).mockRejectedValue(new Error('terminal_handle_stale'))
    const receipt = (await h.call('orchestration.workerRelease', { dispatch: dispatchId })) as {
      state: string
      recovery?: string
    }
    expect(receipt.state).toBe('release_unknown')
    expect(receipt.recovery).toContain('worker-show')
    expect(receipt.recovery).toContain('fresh request ID')
    expect(receipt.recovery).not.toContain('same --retry-request')
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()

    vi.mocked(h.runtime.showTerminal).mockImplementation(
      async (handle) => ({ handle, worktreeId: 'repo::worktree', status: 'running' }) as never
    )
    const retry = (await h.call('orchestration.workerRelease', { dispatch: dispatchId })) as {
      state: string
    }
    expect(retry.state).toBe('released')
    expect(h.runtime.closeTerminal).toHaveBeenCalledTimes(1)
  })
})
