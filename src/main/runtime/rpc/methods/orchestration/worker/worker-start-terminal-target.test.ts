import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'

describe('worker-start --terminal target', () => {
  const harness = createOrchestrationWorkerReleaseHarness()
  beforeEach(() => harness.setup())
  afterEach(() => harness.cleanup())

  it('refuses the coordinator terminal by handle', async () => {
    const task = harness.db.createTask({ spec: 'self adoption', runId: harness.activeRunId })

    await expect(
      harness.call('orchestration.workerStart', {
        task: task.id,
        from: 'term_coord',
        terminal: 'term_coord'
      })
    ).rejects.toMatchObject({
      code: 'terminal_is_coordinator',
      message: expect.stringContaining("coordinator's own terminal")
    })
    expect(harness.db.getDispatchContext(task.id)).toBeUndefined()
  })

  it('refuses a different handle that resolves to the coordinator pane', async () => {
    const task = harness.db.createTask({ spec: 'self adoption alias', runId: harness.activeRunId })
    vi.spyOn(harness.runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord' || handle === 'term_coord_alias' ? harness.coordinatorPaneKey : null
    )

    await expect(
      harness.call('orchestration.workerStart', {
        task: task.id,
        from: 'term_coord',
        terminal: 'term_coord_alias'
      })
    ).rejects.toMatchObject({ code: 'terminal_is_coordinator' })
  })

  it('still accepts a separate agent terminal in the same worktree', async () => {
    const started = await harness.startWorker({ terminal: 'term_worker' })
    expect(started.dispatchId).toEqual(expect.any(String))
  })
})

// The other door into the same self-adoption: manual dispatch never compared `to` to the caller.
describe('orchestration.dispatch --to the caller', () => {
  const harness = createOrchestrationWorkerReleaseHarness()
  beforeEach(() => harness.setup())
  afterEach(() => harness.cleanup())

  it('refuses an injected dispatch aimed at the coordinator handle', async () => {
    vi.spyOn(harness.runtime, 'getOrchestrationDispatchAuthority').mockImplementation(
      (handle) =>
        ({
          terminalHandle: handle,
          paneKey: harness.coordinatorPaneKey,
          processIncarnation: 'runtime_test:term_coord:1'
        }) as never
    )
    const task = harness.db.createTask({ spec: 'self dispatch', runId: harness.activeRunId })

    await expect(
      harness.call('orchestration.dispatch', {
        task: task.id,
        from: 'term_coord',
        to: 'term_coord',
        inject: true
      })
    ).rejects.toMatchObject({ code: 'terminal_is_coordinator' })
    expect(harness.db.getDispatchContext(task.id)).toBeUndefined()
    expect(harness.runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })

  it('refuses an injected dispatch to a different handle that resolves to the coordinator pane', async () => {
    vi.spyOn(harness.runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord' || handle === 'term_coord_alias' ? harness.coordinatorPaneKey : null
    )
    vi.spyOn(harness.runtime, 'getOrchestrationDispatchAuthority').mockImplementation(
      (handle) =>
        ({
          terminalHandle: handle,
          paneKey: harness.coordinatorPaneKey,
          processIncarnation: 'runtime_test:term_coord:1'
        }) as never
    )
    const task = harness.db.createTask({ spec: 'self dispatch alias', runId: harness.activeRunId })

    await expect(
      harness.call('orchestration.dispatch', {
        task: task.id,
        from: 'term_coord',
        to: 'term_coord_alias',
        inject: true
      })
    ).rejects.toMatchObject({ code: 'terminal_is_coordinator' })
  })

  // Low-level topologies (and the e2e specs that drive them from one pane) dispatch context
  // to the caller's own terminal; nothing is written into the pane, so nothing self-adopts.
  it('still records a context-only dispatch aimed at the coordinator handle', async () => {
    const task = harness.db.createTask({ spec: 'self context', runId: harness.activeRunId })

    const result = (await harness.call('orchestration.dispatch', {
      task: task.id,
      from: 'term_coord',
      to: 'term_coord'
    })) as { dispatch: { id: string; status: string } }

    expect(result.dispatch.status).toBe('dispatched')
    expect(harness.db.getDispatchContextById(result.dispatch.id)?.assignee_handle).toBe(
      'term_coord'
    )
    expect(harness.runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })

  // The rejection for a missing agent tells the caller to dispatch without --inject, which the
  // coordinator guard forbids; the self-target answer must not depend on agent presence.
  it.each([
    ['the coordinator handle', 'term_coord'],
    ['an alias of the coordinator pane', 'term_coord_alias']
  ])('refuses %s even when no agent is detected', async (_label, target) => {
    vi.spyOn(harness.runtime, 'isTerminalRunningAgent').mockResolvedValue(false)
    vi.spyOn(harness.runtime, 'getOrchestrationDispatchAuthority').mockImplementation(
      (handle) =>
        (handle === 'term_coord_alias'
          ? {
              terminalHandle: handle,
              paneKey: harness.coordinatorPaneKey,
              processIncarnation: 'runtime_test:term_coord:1'
            }
          : null) as never
    )
    const task = harness.db.createTask({
      spec: `self inject ${target}`,
      runId: harness.activeRunId
    })

    await expect(
      harness.call('orchestration.dispatch', {
        task: task.id,
        from: 'term_coord',
        to: target,
        inject: true
      })
    ).rejects.toMatchObject({ code: 'terminal_is_coordinator' })
    expect(harness.db.getDispatchContext(task.id)).toBeUndefined()
  })

  it('still dispatches to a different pane', async () => {
    const task = harness.db.createTask({ spec: 'peer dispatch', runId: harness.activeRunId })
    const result = (await harness.call('orchestration.dispatch', {
      task: task.id,
      from: 'term_coord',
      to: 'term_worker'
    })) as { dispatch: { assignee_pane_key: string } }
    expect(result.dispatch.assignee_pane_key).toBe(harness.workerPaneKey)
  })
})
