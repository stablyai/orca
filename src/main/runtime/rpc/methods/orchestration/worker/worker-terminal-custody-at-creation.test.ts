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
import type { TuiAgent } from '../../../../../../shared/tui-agent'
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

  /** Holds the agent boot open (a paste's readiness wait, a launch brief's turn) mid-start. */
  function holdBootWait(): { finish: (satisfied?: boolean) => void } {
    const gate = h.deferred<unknown>()
    const turn = h.deferred<'observed'>()
    vi.spyOn(h.runtime, 'waitForTerminal').mockReturnValue(gate.promise as never)
    vi.spyOn(h.runtime, 'observeTerminalLaunchTurnStart').mockReturnValue(turn.promise)
    return {
      finish: (satisfied = true) => {
        // A startup dialog fails a paste's readiness wait and a launch brief's turn watch alike.
        gate.resolve(
          satisfied
            ? READY_WAIT
            : { ...READY_WAIT, satisfied: false, blockedReason: 'codex-update-prompt' }
        )
        if (satisfied) {
          turn.resolve('observed')
        }
      }
    }
  }

  function startingDispatchId(): string {
    return (
      h.db.db
        .prepare("SELECT dispatch_id FROM worker_dispatches WHERE state = 'starting'")
        .get() as { dispatch_id: string }
    ).dispatch_id
  }

  async function startHeldAtBootWait(
    options: { terminal?: string; agent?: TuiAgent } = {}
  ): Promise<{
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
      ...(options.terminal ? { terminal: options.terminal } : { agent: options.agent ?? 'codex' })
    })
    // Both a paste's readiness wait and a launch brief's dialog watch call it.
    await vi.waitFor(() => expect(h.runtime.waitForTerminal).toHaveBeenCalled())
    return { dispatchId: startingDispatchId(), taskId: task.id, start, finish }
  }

  // codex carries its brief on the launch line; aider takes it only as a paste after start.
  it.each(['codex', 'aider'] as const)(
    'owns the created %s terminal before its boot resolves',
    async (agent) => {
      h.setup()
      const held = await startHeldAtBootWait({ agent })

      expect(h.db.getWorkerTerminalResourceByOwner(held.dispatchId)).toMatchObject({
        ownership_state: 'owned',
        release_state: 'not_requested',
        terminal_handle: 'term_worker',
        pane_key: h.workerPaneKey,
        process_incarnation: 'runtime_test:term_worker:1',
        host_scope: JSON.stringify({ kind: 'local', hostId: 'local' })
      })
      // worker-list reads the same row: a booting worker now says `active`, not `retained`.
      expect(h.db.listWorkerTerminalResources({ dispatchIds: [held.dispatchId] })[0]).toMatchObject(
        {
          agentTerminalHandle: 'term_worker',
          terminalState: 'active'
        }
      )

      held.finish()
      await expect(held.start).resolves.toMatchObject({ state: 'ready' })
      expect(h.runtime.sendTerminalAgentPrompt).toHaveBeenCalledTimes(agent === 'aider' ? 1 : 0)
    }
  )

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

  // Why codex differs: its brief is already on its launch line, so answering the dialog runs it.
  it('keeps a codex start blocked at boot unknown, still owning the terminal the brief runs in', async () => {
    h.setup()
    const held = await startHeldAtBootWait({ agent: 'codex' })
    held.finish(false)

    await expect(held.start).resolves.toMatchObject({
      state: 'outcome_unknown',
      stage: 'turn_start_blocked'
    })
    expect(h.db.getWorkerTerminalResourceByOwner(held.dispatchId)).toMatchObject({
      ownership_state: 'owned',
      terminal_handle: 'term_worker'
    })
  })

  it.each([['aider', 'agent_readiness']] as const)(
    'leaves a %s start that died at boot a terminal worker-release can close',
    async (agent, failedStage) => {
      h.setup()
      const held = await startHeldAtBootWait({ agent })
      held.finish(false)

      await expect(held.start).resolves.toMatchObject({
        state: 'failed',
        failedStage,
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
    }
  )

  // The host drops out of codex's launch-turn watch, or out of aider's pre-paste readiness wait.
  it.each([
    ['codex', 'observeTerminalLaunchTurnStart'],
    ['aider', 'waitForTerminal']
  ] as const)(
    'promises no cleanup while a %s start outcome is still unknown',
    async (agent, wait) => {
      h.setup()
      const task = h.db.createTask({ spec: 'unknown outcome', runId: h.activeRunId })
      const unknown = Object.assign(new Error('the execution host went away'), {
        code: 'operation_unknown'
      })
      vi.spyOn(h.runtime, wait).mockRejectedValue(unknown)

      const receipt = await h.call('orchestration.workerStart', {
        task: task.id,
        from: 'term_coord',
        agent
      })

      expect(receipt).toMatchObject({
        state: 'outcome_unknown',
        nextCommands: expect.arrayContaining([expect.stringContaining('worker-abandon')])
      })
      // worker-release refuses an unsettled worker, so the receipt must not name it.
      expect(receipt).not.toHaveProperty('recovery')
      const dispatchId =
        typeof receipt === 'object' && receipt !== null && 'dispatchId' in receipt
          ? String(receipt.dispatchId)
          : ''
      expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
        ownership_state: 'owned'
      })
    }
  )

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
