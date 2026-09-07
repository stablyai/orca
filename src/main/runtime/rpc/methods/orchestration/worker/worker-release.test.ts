import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'

describe('orchestration worker release', () => {
  const h = createOrchestrationWorkerReleaseHarness()

  afterEach(() => h.cleanup())

  it('creates an owned resource for a fresh worker terminal', async () => {
    h.setup()
    const { dispatchId } = await h.startWorker()
    const resource = h.db.getWorkerTerminalResourceByOwner(dispatchId)
    expect(resource).toMatchObject({
      ownership_state: 'owned',
      release_state: 'not_requested',
      terminal_handle: 'term_worker',
      pane_key: h.workerPaneKey,
      process_incarnation: 'runtime_test:term_worker:1'
    })
  })

  it('releases a succeeded worker: archives then closes exactly the agent terminal', async () => {
    h.setup()
    const { dispatchId } = await h.startSettledWorker('succeeded')

    const receipt = (await h.call('orchestration.workerRelease', { dispatch: dispatchId })) as {
      state: string
      processAction: string
      archive: { source: string | null; status: string | null } | null
    }

    expect(receipt).toMatchObject({
      state: 'released',
      processAction: 'closed_agent_terminal',
      archive: { source: 'terminal', status: 'captured' }
    })
    expect(h.runtime.closeTerminal).toHaveBeenCalledTimes(1)
    expect(h.runtime.closeTerminal).toHaveBeenCalledWith('term_worker')
    const resource = h.db.getWorkerTerminalResourceByOwner(dispatchId)
    expect(resource?.release_state).toBe('released')
    expect(resource?.ownership_state).toBe('released')
    // Outcome is untouched by release.
    expect(h.db.getWorkerDispatch(dispatchId)?.state).toBe('succeeded')
  })

  it('does not record recovery bookkeeping for an interactive release', async () => {
    h.setup()
    const { dispatchId } = await h.startSettledWorker()
    const resourceId = h.db.getWorkerTerminalResourceByOwner(dispatchId)?.id
    expect(resourceId).toBeDefined()

    await expect(
      h.call('orchestration.workerRelease', { dispatch: dispatchId })
    ).resolves.toMatchObject({ state: 'released' })

    expect(h.db.getWorkerTerminalResource(resourceId!)).toMatchObject({
      recovery_attempt_count: 0,
      last_recovery_at: null
    })
  })

  it('releases a failed worker the same way', async () => {
    h.setup()
    const { dispatchId } = await h.startSettledWorker('failed')
    const receipt = (await h.call('orchestration.workerRelease', { dispatch: dispatchId })) as {
      state: string
    }
    expect(receipt.state).toBe('released')
    expect(h.db.getWorkerDispatch(dispatchId)?.state).toBe('failed')
  })

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

  it('rejects an active worker without recording release intent', async () => {
    h.setup()
    const { dispatchId } = await h.startWorker()
    await expect(h.call('orchestration.workerRelease', { dispatch: dispatchId })).rejects.toThrow(
      /only a settled worker can release/
    )
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
    expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('not_requested')
  })

  it('retains an explicitly reused external terminal without closing it', async () => {
    h.setup()
    const { dispatchId } = await h.startSettledWorker('succeeded', { terminal: 'term_worker' })
    const receipt = (await h.call('orchestration.workerRelease', { dispatch: dispatchId })) as {
      state: string
      reason?: string
    }
    expect(receipt).toMatchObject({ state: 'retained', reason: 'external_terminal' })
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
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

  it('retains dead inventory evidence when persisted ownership history is invalid', async () => {
    h.setup()
    const { dispatchId } = await h.startSettledWorker('succeeded', { terminal: 'term_worker' })
    const resource = h.db.getWorkerTerminalResourceByOwner(dispatchId)
    const raw = (
      h.db as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }
    ).db
    raw
      .prepare('UPDATE worker_terminal_resources SET prior_owner_dispatch_ids = ? WHERE id = ?')
      .run('{invalid', resource?.id)
    h.inspectProcessLiveness.mockResolvedValue('exited')

    await expect(
      h.call('orchestration.workerRelease', { dispatch: dispatchId })
    ).resolves.toMatchObject({ state: 'retained', processAction: 'none' })
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
    expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).not.toBe('released')
  })

  it('retains a user-taken-over terminal durably', async () => {
    h.setup()
    const { dispatchId } = await h.startSettledWorker()
    const changed = (await h.call('orchestration.workerTerminalUserInput', {
      paneKey: h.workerPaneKey
    })) as { changed: number }
    expect(changed.changed).toBe(1)
    const receipt = (await h.call('orchestration.workerRelease', { dispatch: dispatchId })) as {
      state: string
      reason?: string
    }
    expect(receipt).toMatchObject({ state: 'retained', reason: 'user_takeover' })
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
    expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)?.ownership_state).toBe('user_owned')
  })

  it('keeps a dead user-taken-over terminal in the user takeover', async () => {
    h.setup()
    const { dispatchId } = await h.startSettledWorker()
    await h.call('orchestration.workerTerminalUserInput', { paneKey: h.workerPaneKey })
    h.inspectProcessLiveness.mockResolvedValue('exited')

    await expect(
      h.call('orchestration.workerRelease', { dispatch: dispatchId })
    ).resolves.toMatchObject({ state: 'retained', reason: 'user_takeover', processAction: 'none' })
    expect(h.inspectProcessLiveness).toHaveBeenCalledWith(
      'runtime_test:term_worker:1',
      JSON.stringify({ kind: 'local', hostId: 'local' })
    )
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
    expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      ownership_state: 'user_owned',
      release_state: 'retained'
    })
  })

  // A stopped/abandoned worker never reaches `release_state = 'requested'`, so no archive can
  // ever exist for it; refusing the release left the owned pane retained forever.
  it.each(['stopped', 'abandoned'] as const)(
    'releases a dead %s worker whose output could never be archived',
    async (state) => {
      h.setup()
      const { dispatchId } = await h.startWorker()
      if (state === 'stopped') {
        h.db.beginWorkerStop(dispatchId, h.runtime.getRuntimeId())
        h.db.settleWorkerStop(dispatchId)
      } else {
        h.db.abandonWorkerDispatch(dispatchId)
      }
      h.inspectProcessLiveness.mockResolvedValue('exited')

      await expect(
        h.call('orchestration.workerRelease', { dispatch: dispatchId })
      ).resolves.toMatchObject({
        state: 'released',
        processAction: 'none',
        archive: { status: 'unavailable' }
      })
      expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
      expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
        ownership_state: 'released',
        release_state: 'released',
        archive_status: 'unavailable'
      })
    }
  )

  it.each(['stopped', 'abandoned'] as const)(
    'keeps a dead %s worker retained while its process is still unproven',
    async (state) => {
      h.setup()
      const { dispatchId } = await h.startWorker()
      if (state === 'stopped') {
        h.db.beginWorkerStop(dispatchId, h.runtime.getRuntimeId())
        h.db.settleWorkerStop(dispatchId)
      } else {
        h.db.abandonWorkerDispatch(dispatchId)
      }
      h.inspectProcessLiveness.mockResolvedValue('unverifiable')

      await expect(
        h.call('orchestration.workerRelease', { dispatch: dispatchId })
      ).resolves.toMatchObject({
        state: 'retained',
        reason: 'identity_unproven',
        processAction: 'none'
      })
      expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).not.toBe('released')
    }
  )

  it('lets user takeover cancel a release while output capture is pending', async () => {
    h.setup()
    const { dispatchId } = await h.startSettledWorker()
    const pendingRead = h.deferred<Awaited<ReturnType<OrcaRuntimeService['readTerminal']>>>()
    vi.mocked(h.runtime.readTerminal).mockReturnValue(pendingRead.promise)

    const release = h.call('orchestration.workerRelease', { dispatch: dispatchId })
    await vi.waitFor(() => expect(h.runtime.readTerminal).toHaveBeenCalledTimes(1))
    const changed = (await h.call('orchestration.workerTerminalUserInput', {
      paneKey: h.workerPaneKey
    })) as { changed: number }
    expect(changed.changed).toBe(1)
    pendingRead.resolve({
      handle: 'term_worker',
      status: 'running',
      tail: ['captured before takeover'],
      truncated: false,
      nextCursor: '1'
    })

    await expect(release).resolves.toMatchObject({ state: 'retained', reason: 'user_takeover' })
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
    expect(h.db.getWorkerTerminalArchive(dispatchId)).toBeUndefined()
  })

  it('lets an explicit retain cancel a release while output capture is pending', async () => {
    h.setup()
    const { dispatchId } = await h.startSettledWorker()
    const pendingRead = h.deferred<Awaited<ReturnType<OrcaRuntimeService['readTerminal']>>>()
    vi.mocked(h.runtime.readTerminal).mockReturnValue(pendingRead.promise)

    const release = h.call('orchestration.workerRelease', { dispatch: dispatchId })
    await vi.waitFor(() => expect(h.runtime.readTerminal).toHaveBeenCalledTimes(1))
    await expect(
      h.call('orchestration.workerRetain', { dispatch: dispatchId })
    ).resolves.toMatchObject({ state: 'retained', reason: 'user_requested' })
    pendingRead.resolve({
      handle: 'term_worker',
      status: 'running',
      tail: ['captured before retention'],
      truncated: false,
      nextCursor: '1'
    })

    await expect(release).resolves.toMatchObject({ state: 'retained', reason: 'user_requested' })
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
    expect(h.db.getWorkerTerminalArchive(dispatchId)).toBeUndefined()
  })

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

  it('never marks takeover for panes without an owned resource', async () => {
    h.setup()
    const changed = (await h.call('orchestration.workerTerminalUserInput', {
      paneKey: 'tab_other:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    })) as { changed: number }
    expect(changed.changed).toBe(0)
  })

  it('preserves takeover across a reminted tab key for the same pane leaf', async () => {
    h.setup()
    const { dispatchId } = await h.startSettledWorker()
    const changed = (await h.call('orchestration.workerTerminalUserInput', {
      paneKey: 'tab_reminted:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    })) as { changed: number }

    expect(changed.changed).toBe(1)
    expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)?.ownership_state).toBe('user_owned')
  })

  it('retains when the exact process identity changed instead of closing', async () => {
    h.setup()
    const { dispatchId } = await h.startSettledWorker()
    vi.mocked(h.runtime.getTerminalProcessIncarnation).mockImplementation((handle) =>
      handle === 'term_worker' ? 'runtime_test:term_worker:2' : null
    )
    const receipt = (await h.call('orchestration.workerRelease', { dispatch: dispatchId })) as {
      state: string
      reason?: string
    }
    expect(receipt).toMatchObject({ state: 'retained', reason: 'identity_unproven' })
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it('retains when the terminal host scope changed instead of closing', async () => {
    h.setup()
    const { dispatchId } = await h.startSettledWorker()
    vi.mocked(h.runtime.getOrchestrationDispatchAuthority).mockReturnValue({
      terminalHandle: 'term_worker',
      paneKey: h.workerPaneKey,
      processIncarnation: 'runtime_test:term_worker:1',
      hostScope: { kind: 'ssh', targetId: 'replacement-host' }
    } as never)

    await expect(
      h.call('orchestration.workerRelease', { dispatch: dispatchId })
    ).resolves.toMatchObject({ state: 'retained', reason: 'identity_unproven' })
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it('re-proves process identity after archive capture before closing', async () => {
    h.setup()
    const { dispatchId } = await h.startSettledWorker()
    const pendingRead = h.deferred<Awaited<ReturnType<OrcaRuntimeService['readTerminal']>>>()
    vi.mocked(h.runtime.readTerminal).mockReturnValue(pendingRead.promise)

    const release = h.call('orchestration.workerRelease', { dispatch: dispatchId })
    await vi.waitFor(() => expect(h.runtime.readTerminal).toHaveBeenCalledTimes(1))
    vi.mocked(h.runtime.getTerminalProcessIncarnation).mockImplementation((handle) =>
      handle === 'term_worker' ? 'runtime_test:term_worker:2' : null
    )
    pendingRead.resolve({
      handle: 'term_worker',
      status: 'running',
      tail: ['output from the old process'],
      truncated: false,
      nextCursor: '1'
    })

    await expect(release).resolves.toMatchObject({
      state: 'retained',
      reason: 'identity_unproven'
    })
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
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

  it('retains the live terminal when output capture fails', async () => {
    h.setup()
    const { dispatchId } = await h.startSettledWorker()
    vi.mocked(h.runtime.readTerminal).mockRejectedValue(new Error('read exploded'))
    await expect(h.call('orchestration.workerRelease', { dispatch: dispatchId })).rejects.toThrow(
      /Output could not be preserved/
    )
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
    // Durable intent survives for recovery.
    expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('requested')
  })

  it('marks release_unknown when the close itself fails', async () => {
    h.setup()
    const { dispatchId } = await h.startSettledWorker()
    vi.mocked(h.runtime.closeTerminal).mockRejectedValue(new Error('close exploded'))
    const receipt = (await h.call('orchestration.workerRelease', { dispatch: dispatchId })) as {
      state: string
      lastError?: string
      recovery?: string
    }
    expect(receipt.state).toBe('release_unknown')
    expect(receipt.recovery).toContain('fresh request ID')
    expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('unknown')
  })
})
