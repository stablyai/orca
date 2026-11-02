/**
 * A failed worker-start keeps the terminal it created (a pane the user typed into is theirs), and
 * `--retry-of` launches a new agent in a new terminal. Without releasing the failed attempt's
 * terminal on retry, every retry of a start that can never succeed left one more live agent.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../../../orchestration/db'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'
import { releaseRetriedWorkerTerminal } from './retried-worker-terminal-release'
import type { RuntimeTerminalWait } from '../../../../../../shared/runtime-terminal-contracts'

const RETRY_PANE_KEY = 'tab_retry:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const BLOCKED_WAIT: RuntimeTerminalWait = {
  handle: 'term_worker',
  condition: 'tui-idle',
  satisfied: false,
  status: 'running',
  exitCode: null,
  blockedReason: 'agent-interactive-prompt'
}

describe('retrying a failed worker-start', () => {
  const h = createOrchestrationWorkerReleaseHarness()

  afterEach(() => h.cleanup())

  /** The retry launches into its own terminal, as a real start does. */
  function giveRetryItsOwnTerminal(): void {
    const paneKeys: Record<string, string> = {
      term_coord: h.coordinatorPaneKey,
      term_worker: h.workerPaneKey,
      term_retry: RETRY_PANE_KEY
    }
    vi.spyOn(h.runtime, 'createTerminal')
      .mockResolvedValueOnce({ handle: 'term_worker', worktreeId: 'repo::worktree', title: 'w' })
      .mockResolvedValue({ handle: 'term_retry', worktreeId: 'repo::worktree', title: 'r' })
    vi.spyOn(h.runtime, 'getTerminalPaneKey').mockImplementation((handle) => paneKeys[handle])
    vi.spyOn(h.runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
      handle === 'term_worker' || handle === 'term_retry' ? `runtime_test:${handle}:1` : null
    )
    vi.spyOn(h.runtime, 'getOrchestrationDispatchAuthority').mockImplementation((handle) =>
      handle === 'term_worker' || handle === 'term_retry'
        ? {
            runtimeId: 'runtime_test',
            terminalHandle: handle,
            ptyId: `pty_${handle}`,
            worktreeId: 'repo::worktree',
            paneKey: paneKeys[handle],
            processIncarnation: `runtime_test:${handle}:1`,
            launchTokenHash: null,
            hostScope: { kind: 'local', hostId: 'local' }
          }
        : null
    )
  }

  async function failFirstStart(): Promise<{ taskId: string; dispatchId: string }> {
    giveRetryItsOwnTerminal()
    vi.spyOn(h.runtime, 'waitForTerminal').mockResolvedValue(BLOCKED_WAIT)
    const task = h.db.createTask({ spec: 'blocked at a prompt', runId: h.activeRunId })
    const receipt = await h.call('orchestration.workerStart', {
      task: task.id,
      from: 'term_coord',
      agent: 'codex'
    })
    expect(receipt).toMatchObject({
      state: 'failed',
      lastError: 'Agent startup blocked: agent-interactive-prompt'
    })
    return { taskId: task.id, dispatchId: dispatchIdOf(receipt) }
  }

  function dispatchIdOf(receipt: unknown): string {
    if (
      typeof receipt !== 'object' ||
      receipt === null ||
      !('dispatchId' in receipt) ||
      typeof receipt.dispatchId !== 'string'
    ) {
      throw new Error('worker-start returned no dispatch')
    }
    return receipt.dispatchId
  }

  function retry(failed: { taskId: string; dispatchId: string }): Promise<unknown> {
    return h.call('orchestration.workerStart', {
      task: failed.taskId,
      retryOf: failed.dispatchId,
      from: 'term_coord',
      agent: 'codex'
    })
  }

  it("releases the failed attempt's terminal through the normal release", async () => {
    h.setup()
    const failed = await failFirstStart()
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()

    await expect(retry(failed)).resolves.toMatchObject({ state: 'failed' })

    await vi.waitFor(() =>
      expect(h.db.getWorkerTerminalResourceByOwner(failed.dispatchId)).toMatchObject({
        release_state: 'released',
        archive_status: 'captured'
      })
    )
    expect(h.runtime.closeTerminal).toHaveBeenCalledWith('term_worker')
    expect(h.runtime.closeTerminal).not.toHaveBeenCalledWith('term_retry')
    expect(h.db.getWorkerTerminalArchive(failed.dispatchId)).toBeTruthy()
  })

  it('also releases a worker that ran and reported its own failure', async () => {
    h.setup()
    giveRetryItsOwnTerminal()
    const ran = await h.startSettledWorker('failed')
    vi.spyOn(h.runtime, 'waitForTerminal').mockResolvedValue(BLOCKED_WAIT)

    await retry(ran)

    await vi.waitFor(() =>
      expect(h.db.getWorkerTerminalResourceByOwner(ran.dispatchId)?.release_state).toBe('released')
    )
    expect(h.runtime.closeTerminal).toHaveBeenCalledWith('term_worker')
  })

  it('keeps a pane the user typed into', async () => {
    h.setup()
    const failed = await failFirstStart()
    await h.call('orchestration.workerTerminalUserInput', { paneKey: h.workerPaneKey })

    await retry(failed)

    expect(h.db.getWorkerTerminalResourceByOwner(failed.dispatchId)).toMatchObject({
      ownership_state: 'user_owned',
      retained_reason: 'user_takeover'
    })
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it('does nothing for a terminal the coordinator already released', async () => {
    h.setup()
    const failed = await failFirstStart()
    await expect(
      h.call('orchestration.workerRelease', { dispatch: failed.dispatchId })
    ).resolves.toMatchObject({ state: 'released' })

    await retry(failed)

    expect(h.runtime.closeTerminal).toHaveBeenCalledTimes(1)
  })

  it('leaves the pane alone when the retry reuses a terminal explicitly', async () => {
    h.setup()
    const failed = await failFirstStart()
    vi.spyOn(h.runtime, 'waitForTerminal').mockResolvedValue({
      ...BLOCKED_WAIT,
      satisfied: true,
      blockedReason: undefined
    })

    await h.call('orchestration.workerStart', {
      task: failed.taskId,
      retryOf: failed.dispatchId,
      from: 'term_coord',
      terminal: 'term_retry'
    })

    expect(h.db.getWorkerTerminalResourceByOwner(failed.dispatchId)?.release_state).toBe(
      'not_requested'
    )
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it('stops a retry loop at the third failed start', async () => {
    h.setup()
    const first = await failFirstStart()
    const second = dispatchIdOf(await retry(first))
    const third = dispatchIdOf(await retry({ taskId: first.taskId, dispatchId: second }))

    expect(h.db.getDispatchContextById(third)).toMatchObject({
      status: 'circuit_broken',
      failure_count: 3
    })
    await expect(retry({ taskId: first.taskId, dispatchId: third })).rejects.toThrow(
      /failed 3 times, so Orca will not retry it again/
    )
    expect(h.runtime.createTerminal).toHaveBeenCalledTimes(3)
    // The refused retry replaced nothing, so the last attempt's pane stays for the user.
    expect(h.db.getWorkerTerminalResourceByOwner(third)?.release_state).toBe('not_requested')
  })
})

describe('releaseRetriedWorkerTerminal', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => db?.close())

  it('leaves a structured worker session to its own teardown', () => {
    const d = (db = new OrchestrationDb(':memory:'))
    const task = d.createTask({ runId: 'run_legacy_local', spec: 'structured' })
    const { dispatch } = d.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    d.recordCreatedWorkerTerminalCustody({
      dispatchId: dispatch.id,
      handle: 'structworker_1',
      paneKey: 'tab_s:dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      processIncarnation: 'structured:1',
      worktreeId: 'wt'
    })
    d.failWorkerStart(dispatch.id, 'agent_readiness', 'never ready')
    const request = vi.spyOn(d, 'requestWorkerTerminalRelease')

    releaseRetriedWorkerTerminal(new OrcaRuntimeService(), d, { retryOf: dispatch.id })

    expect(request).not.toHaveBeenCalled()
    expect(d.getWorkerTerminalResourceByOwner(dispatch.id)?.release_state).toBe('not_requested')
  })
})
