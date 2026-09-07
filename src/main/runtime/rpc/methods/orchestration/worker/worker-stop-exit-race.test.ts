import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  OPERATOR_CLOSE_EXIT_CAUSE,
  type TerminalExitCause
} from '../../../../../../shared/terminal-exit-cause'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'

const h = createOrchestrationWorkerReleaseHarness()
beforeEach(() => h.setup())
afterEach(() => h.cleanup())

type StopReceipt = { state: string; alreadySettled: boolean; processAction: string }

function fireExit(handle: string, cause: TerminalExitCause = OPERATOR_CLOSE_EXIT_CAUSE): void {
  ;(
    h.runtime as unknown as {
      failActiveDispatchOnExit: (
        handle: string,
        paneKey: string | null,
        exitCode: number,
        cause: TerminalExitCause
      ) => void
    }
  ).failActiveDispatchOnExit(handle, h.workerPaneKey, 0, cause)
}

describe('a worker whose process exits while its own stop is in flight', () => {
  it('reports the stop that succeeded, not a failed dispatch', async () => {
    const { dispatchId } = await h.startWorker()
    // The PTY exit lands between beginWorkerStop and settleWorkerStop.
    vi.mocked(h.runtime.closeTerminal).mockImplementation(async (handle) => {
      fireExit(handle)
      return { handle, tabId: 'tab-worker', ptyKilled: true } as never
    })

    const receipt = (await h.call('orchestration.workerStop', {
      dispatch: dispatchId
    })) as StopReceipt
    expect(receipt).toMatchObject({ state: 'stopped', processAction: 'closed_agent_terminal' })
    expect(h.db.getWorkerDispatch(dispatchId)?.state).toBe('stopped')

    const second = (await h.call('orchestration.workerStop', {
      dispatch: dispatchId
    })) as StopReceipt
    expect(second).toMatchObject({ state: 'stopped', alreadySettled: true })
  })

  it('still reports the stop when the exit races a close that then throws', async () => {
    const { dispatchId } = await h.startWorker()
    vi.mocked(h.runtime.closeTerminal).mockImplementation(async (handle) => {
      fireExit(handle)
      throw new Error('Terminal handle is stale')
    })

    const receipt = (await h.call('orchestration.workerStop', {
      dispatch: dispatchId
    })) as StopReceipt
    expect(receipt.state).toBe('stopped')
  })

  it('accepts an exit observed while inspecting the process before close', async () => {
    const { dispatchId } = await h.startWorker()
    vi.mocked(h.runtime.showTerminal).mockImplementation(async (handle) => {
      fireExit(handle)
      return { handle, connected: false } as never
    })
    vi.spyOn(h.runtime, 'getTerminalLivenessVerdict').mockReturnValue({ status: 'exited' })

    await expect(
      h.call('orchestration.workerStop', { dispatch: dispatchId })
    ).resolves.toMatchObject({ state: 'stopped', processAction: 'none' })
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it('leaves an exit with no stop in flight failing the dispatch', async () => {
    const { dispatchId } = await h.startWorker()
    fireExit('term_worker')
    expect(h.db.getWorkerDispatch(dispatchId)?.state).toBe('failed')
  })

  it('certifies a later death instead of crediting a stopping row from a dead runtime', async () => {
    const { dispatchId } = await h.startWorker()
    // The stop RPC committed `stopping` in an earlier runtime and the app died before settling.
    h.db.beginWorkerStop(dispatchId, 'runtime_from_a_previous_process')
    expect(h.db.getWorkerDispatch(dispatchId)?.state).toBe('stopping')

    fireExit('term_worker', { kind: 'signaled', signal: 9 })

    expect(h.db.getDispatchContextById(dispatchId)?.termination_reason).toBe('signaled')
    expect(h.db.getWorkerDispatch(dispatchId)?.state).toBe('failed')
  })

  it('gives a second concurrent stop the first caller receipt, not dispatch_inactive', async () => {
    const { dispatchId } = await h.startWorker()

    const [first, second] = await Promise.all([
      h.call('orchestration.workerStop', { dispatch: dispatchId }) as Promise<StopReceipt>,
      h.call('orchestration.workerStop', { dispatch: dispatchId }) as Promise<StopReceipt>
    ])

    expect(first).toMatchObject({ state: 'stopped' })
    expect(second).toEqual(first)
    expect(h.db.getWorkerDispatch(dispatchId)?.state).toBe('stopped')
  })
})
