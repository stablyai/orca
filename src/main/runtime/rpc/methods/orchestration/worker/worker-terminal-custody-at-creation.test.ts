/**
 * Custody for an agent terminal this start created is written when the terminal is created, not
 * after the agent boot wait.
 *
 * A worker pane is visible on desktop and phone the moment it exists. While the row was written
 * only after `tui-idle` (up to 60 s later), a keystroke into the booting pane found no `owned` row,
 * `markWorkerTerminalUserOwned` returned 0, and the takeover was lost — so a later `worker-release`
 * closed the pane the user had claimed.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../../../orchestration/db'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'

const READY_WAIT = {
  handle: 'term_worker',
  condition: 'tui-idle',
  satisfied: true,
  status: 'running',
  exitCode: null
}

describe('worker terminal custody is recorded at terminal creation', () => {
  const h = createOrchestrationWorkerReleaseHarness()

  afterEach(() => h.cleanup())

  /** Holds the agent boot wait open so the mid-start database state can be read. */
  function holdBootWait(): { finish: (satisfied?: boolean) => void } {
    const gate = h.deferred<unknown>()
    vi.spyOn(h.runtime, 'waitForTerminal').mockReturnValue(gate.promise as never)
    return {
      finish: (satisfied = true) =>
        gate.resolve({ ...READY_WAIT, satisfied, status: satisfied ? 'running' : 'exited' })
    }
  }

  function startingDispatchId(): string {
    return (
      h.db.db
        .prepare("SELECT dispatch_id FROM worker_dispatches WHERE state = 'starting'")
        .get() as { dispatch_id: string }
    ).dispatch_id
  }

  async function startHeldAtBootWait(options: { terminal?: string } = {}): Promise<{
    dispatchId: string
    taskId: string
    start: Promise<unknown>
    finish: (satisfied?: boolean) => void
  }> {
    const task = h.db.createTask({ spec: 'custody at creation', runId: h.activeRunId })
    const { finish } = holdBootWait()
    const start = h.call('orchestration.workerStart', {
      task: task.id,
      from: 'term_coord',
      ...(options.terminal ? { terminal: options.terminal } : { agent: 'codex' })
    })
    await vi.waitFor(() => expect(h.runtime.waitForTerminal).toHaveBeenCalled())
    return { dispatchId: startingDispatchId(), taskId: task.id, start, finish }
  }

  it('owns the created terminal before the boot wait resolves', async () => {
    h.setup()
    const held = await startHeldAtBootWait()

    expect(h.db.getWorkerTerminalResourceByOwner(held.dispatchId)).toMatchObject({
      ownership_state: 'owned',
      release_state: 'not_requested',
      terminal_handle: 'term_worker',
      pane_key: h.workerPaneKey,
      process_incarnation: 'runtime_test:term_worker:1',
      host_scope: JSON.stringify({ kind: 'local', hostId: 'local' })
    })
    // worker-list reads the same row: a booting worker now says `active`, not `retained`.
    expect(h.db.listWorkerTerminalResources({ dispatchIds: [held.dispatchId] })[0]).toMatchObject({
      agentTerminalHandle: 'term_worker',
      terminalState: 'active'
    })

    held.finish()
    await expect(held.start).resolves.toMatchObject({ state: 'ready' })
  })

  it('claims nothing for an explicitly reused terminal until authority transfers it', async () => {
    h.setup()
    const held = await startHeldAtBootWait({ terminal: 'term_worker' })

    expect(h.db.getWorkerTerminalResourceByOwner(held.dispatchId)).toBeUndefined()

    held.finish()
    await expect(held.start).resolves.toMatchObject({ state: 'ready' })
    expect(h.db.getWorkerTerminalResourceByOwner(held.dispatchId)).toMatchObject({
      ownership_state: 'external',
      retained_reason: 'external_terminal'
    })
  })

  it('lets a keystroke during the boot wait take the pane, and release then retains it', async () => {
    h.setup()
    const held = await startHeldAtBootWait()

    await expect(
      h.call('orchestration.workerTerminalUserInput', { paneKey: h.workerPaneKey })
    ).resolves.toEqual({ changed: 1 })

    held.finish()
    await expect(held.start).resolves.toMatchObject({ state: 'ready' })
    expect(h.db.getWorkerTerminalResourceByOwner(held.dispatchId)).toMatchObject({
      ownership_state: 'user_owned',
      retained_reason: 'user_takeover'
    })

    h.settle(held.taskId, held.dispatchId, 'succeeded')
    await expect(
      h.call('orchestration.workerRelease', { dispatch: held.dispatchId })
    ).resolves.toMatchObject({ state: 'retained', reason: 'user_takeover', processAction: 'none' })
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it('still refuses to release a starting worker that already owns its terminal', async () => {
    h.setup()
    const held = await startHeldAtBootWait()

    await expect(
      h.call('orchestration.workerRelease', { dispatch: held.dispatchId })
    ).rejects.toThrow(/only a settled worker can release/)

    held.finish()
    await held.start
  })

  it('leaves a start that died on the boot wait a terminal worker-release can close', async () => {
    h.setup()
    const held = await startHeldAtBootWait()
    held.finish(false)

    await expect(held.start).resolves.toMatchObject({
      state: 'failed',
      failedStage: 'agent_readiness',
      recovery: expect.stringContaining('worker-release')
    })
    expect(h.db.getWorkerTerminalResourceByOwner(held.dispatchId)).toMatchObject({
      ownership_state: 'owned',
      terminal_handle: 'term_worker'
    })

    await expect(
      h.call('orchestration.workerRelease', { dispatch: held.dispatchId })
    ).resolves.toMatchObject({ state: 'released', processAction: 'closed_agent_terminal' })
    expect(h.runtime.closeTerminal).toHaveBeenCalledWith('term_worker')
  })

  it('promises no cleanup while the start outcome is still unknown', async () => {
    h.setup()
    const task = h.db.createTask({ spec: 'unknown outcome', runId: h.activeRunId })
    const unknown = Object.assign(new Error('the execution host went away'), {
      code: 'operation_unknown'
    })
    vi.spyOn(h.runtime, 'waitForTerminal').mockRejectedValue(unknown)

    const receipt = (await h.call('orchestration.workerStart', {
      task: task.id,
      from: 'term_coord',
      agent: 'codex'
    })) as { state: string; dispatchId: string; nextCommands?: string[] }

    expect(receipt).toMatchObject({ state: 'outcome_unknown' })
    // worker-release refuses an unsettled worker, so the receipt must not name it.
    expect(receipt).not.toHaveProperty('recovery')
    expect(receipt.nextCommands?.join(' ')).toContain('worker-abandon')
    expect(h.db.getWorkerTerminalResourceByOwner(receipt.dispatchId)).toMatchObject({
      ownership_state: 'owned'
    })
  })

  it('promises no cleanup for a reused terminal whose start died', async () => {
    h.setup()
    const held = await startHeldAtBootWait({ terminal: 'term_worker' })
    held.finish(false)

    const receipt = await held.start
    expect(receipt).toMatchObject({ state: 'failed' })
    expect(receipt).not.toHaveProperty('recovery')
    expect(h.db.getWorkerTerminalResourceByOwner(held.dispatchId)).toBeUndefined()
  })
})

describe('custody refuses a dispatch that stopped while its terminal was being created', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => db?.close())

  it('records no owner once the dispatch is no longer starting', () => {
    const d = (db = new OrchestrationDb(':memory:'))
    const started = d.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: d.createTask({ runId: 'run_legacy_local', spec: 'stopped mid-create' }).id,
      startOptions: {}
    })
    // Startup reconciliation abandons a `starting` worker whose terminal it cannot find.
    d.reconcileMissingWorkerTerminal(started.dispatch.id, 'runtime restarted')

    expect(() =>
      d.recordCreatedWorkerTerminalCustody({
        dispatchId: started.dispatch.id,
        handle: 'term_worker',
        paneKey: 'tab_w:leaf_w',
        processIncarnation: 'pty_w:1',
        worktreeId: 'repo::worktree'
      })
    ).toThrow(/is not starting/)
    expect(d.getWorkerTerminalResourceByOwner(started.dispatch.id)).toBeUndefined()
  })
})
