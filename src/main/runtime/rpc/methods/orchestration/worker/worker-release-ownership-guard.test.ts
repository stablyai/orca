import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'

describe('workerRelease on a retained resource whose process exited', () => {
  const harness = createOrchestrationWorkerReleaseHarness()
  beforeEach(() => harness.setup())
  afterEach(() => harness.cleanup())

  it('does not release a terminal the user took over', async () => {
    const { dispatchId } = await harness.startSettledWorker('succeeded')
    const takeover = (await harness.call('orchestration.workerTerminalUserInput', {
      paneKey: harness.workerPaneKey
    })) as { changed: number }
    expect(takeover.changed).toBe(1)
    expect(harness.db.getWorkerTerminalResourceByOwner(dispatchId)?.ownership_state).toBe(
      'user_owned'
    )

    // The agent process later exits on its own; the user's pane and scrollback remain.
    harness.inspectProcessLiveness.mockResolvedValue('exited')
    const receipt = (await harness.call('orchestration.workerRelease', {
      dispatch: dispatchId
    })) as { state: string; reason?: string; archive: unknown }

    expect(receipt.state).toBe('retained')
    expect(receipt.reason).toBe('user_takeover')
    const after = harness.db.getWorkerTerminalResourceByOwner(dispatchId)
    expect(after?.ownership_state).toBe('user_owned')
    expect(after?.release_state).not.toBe('released')
  })

  it.each(['transferred', 'external'] as const)(
    'does not release a %s resource on an exited process',
    async (ownershipState) => {
      const { dispatchId } = await harness.startSettledWorker('succeeded')
      const resource = harness.db.getWorkerTerminalResourceByOwner(dispatchId)!
      harness.db.db
        .prepare('UPDATE worker_terminal_resources SET ownership_state = ? WHERE id = ?')
        .run(ownershipState, resource.id)

      harness.inspectProcessLiveness.mockResolvedValue('exited')
      const receipt = (await harness.call('orchestration.workerRelease', {
        dispatch: dispatchId
      })) as { state: string }

      expect(receipt.state).toBe('retained')
      const after = harness.db.getWorkerTerminalResourceByOwner(dispatchId)
      expect(after?.ownership_state).toBe(ownershipState)
      expect(after?.release_state).not.toBe('released')
    }
  )

  it('records the archive as unavailable rather than retaining the pane forever', async () => {
    const { dispatchId } = await harness.startWorker()
    // Abandoned workers never reach `requested`, the only state that writes an archive.
    expect(harness.db.abandonWorkerDispatch(dispatchId).disposition).toBe('abandoned')
    expect(harness.db.getWorkerTerminalArchive(dispatchId)).toBeFalsy()

    harness.inspectProcessLiveness.mockResolvedValue('exited')
    const receipt = (await harness.call('orchestration.workerRelease', {
      dispatch: dispatchId
    })) as { state: string; archive: { status: string | null } | null }

    expect(receipt.state).toBe('released')
    expect(receipt.archive?.status).toBe('unavailable')
  })

  it('exits retention after a recovery abandon even once the user retained it', async () => {
    const { dispatchId } = await harness.startWorker()
    harness.db.reconcileMissingWorkerTerminal(dispatchId, 'terminal gone')
    expect(harness.db.getWorkerDispatch(dispatchId)?.state).toBe('abandoned')
    harness.inspectProcessLiveness.mockResolvedValue('exited')

    // retain deletes the archive and parks the row in `retained`: still no route back to `requested`.
    await harness.call('orchestration.workerRetain', { dispatch: dispatchId })
    const receipt = (await harness.call('orchestration.workerRelease', {
      dispatch: dispatchId
    })) as { state: string }

    expect(receipt.state).toBe('released')
  })

  it('still refuses when an archive names a different resource', async () => {
    const { dispatchId } = await harness.startWorker()
    const resource = harness.db.getWorkerTerminalResourceByOwner(dispatchId)!
    expect(harness.db.abandonWorkerDispatch(dispatchId).disposition).toBe('abandoned')
    harness.db.storeWorkerTerminalArchive({
      dispatchId,
      resourceId: `${resource.id}-other`,
      kind: 'terminal_tail',
      content: 'tail'
    })

    harness.inspectProcessLiveness.mockResolvedValue('exited')
    const receipt = (await harness.call('orchestration.workerRelease', {
      dispatch: dispatchId
    })) as { state: string }

    expect(receipt.state).toBe('retained')
    expect(harness.db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).not.toBe(
      'released'
    )
  })
})
