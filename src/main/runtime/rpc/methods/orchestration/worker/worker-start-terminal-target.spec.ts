import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LaunchedAgentForeground } from '../../../../terminal/wait/launched-agent-foreground'
import type { RuntimeTerminalWait } from '../../../../../../shared/runtime-terminal-contracts'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'

export function registerWorkerStartTerminalTargetTests(): void {
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
      const task = harness.db.createTask({
        spec: 'self adoption alias',
        runId: harness.activeRunId
      })
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
  })

  // Manual inject is another self-adoption path; compare target with caller too.
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
      const task = harness.db.createTask({
        spec: 'self dispatch alias',
        runId: harness.activeRunId
      })

      await expect(
        harness.call('orchestration.dispatch', {
          task: task.id,
          from: 'term_coord',
          to: 'term_coord_alias',
          inject: true
        })
      ).rejects.toMatchObject({ code: 'terminal_is_coordinator' })
    })

    // Context-only self-dispatch writes no preamble and remains valid for low-level topologies.
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

    // Self-injection must refuse regardless of agent detection; without-inject advice cannot authorize it.
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
  })

  const PTY_ID = 'pty_worker'

  // A returned shell also reads ready; prove the launched agent is in front before writing the brief.
  describe('a worker start writes its brief only into the agent it launched', () => {
    const h = createOrchestrationWorkerReleaseHarness()
    afterEach(() => h.cleanup())

    function launchedPane(foreground: LaunchedAgentForeground): string[] {
      h.setup()
      const writes: string[] = []
      vi.spyOn(h.runtime, 'readLaunchedAgentForeground').mockResolvedValue(foreground)
      vi.spyOn(h.runtime, 'launchedAgentHostProvesAgent').mockReturnValue(true)
      vi.spyOn(h.runtime, 'subscribeToTerminalData').mockReturnValue(() => {})
      vi.mocked(h.runtime.sendTerminalAgentPrompt).mockImplementation(
        async (handle, text, options) => {
          await options?.beforeWrite?.(PTY_ID)
          writes.push(text)
          return { handle, accepted: true, bytesWritten: text.length }
        }
      )
      return writes
    }

    it('types nothing when the agent exited and its shell is in front', async () => {
      const writes = launchedPane('shell')

      await expect(h.startWorker({ agent: 'claude' })).rejects.toThrow()
      expect(writes).toEqual([])
    })
  })

  describe('composer-marker first dispatch readiness', () => {
    const h = createOrchestrationWorkerReleaseHarness()
    afterEach(() => h.cleanup())

    it.each(['zcode', 'opencode', 'opencode2'] as const)(
      '%s waits for the new composer before dispatch',
      async (agent) => {
        h.setup()
        const gate = h.deferred<RuntimeTerminalWait>()
        vi.spyOn(h.runtime, 'waitForFreshWorkerComposer').mockReturnValue(gate.promise)
        const pending = h.startWorker({ agent })
        await vi.waitFor(() =>
          expect(h.runtime.waitForFreshWorkerComposer).toHaveBeenCalledWith(
            'term_worker',
            agent,
            60_000
          )
        )
        expect(h.runtime.waitForTerminal).not.toHaveBeenCalled()
        expect(h.runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
        gate.resolve({
          handle: 'term_worker',
          condition: 'tui-idle',
          satisfied: true,
          status: 'running',
          exitCode: null
        })
        await pending
        expect(h.runtime.sendTerminalAgentPrompt).toHaveBeenCalledOnce()
      }
    )
  })
}
