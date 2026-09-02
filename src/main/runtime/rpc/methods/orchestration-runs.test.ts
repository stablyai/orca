import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildRegistry, type RpcContext } from '../core'
import { ORCHESTRATION_METHODS } from './orchestration'
import { createOrchestrationRpcHarness } from './orchestration-rpc-test-harness'
import type { OrchestrationDb } from '../../orchestration/db'
import type { OrcaRuntimeService } from '../../orca-runtime'

describe('orchestration RPC methods', () => {
  const h = createOrchestrationRpcHarness()
  const { coordinatorPaneKey } = h
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let ctx: RpcContext

  function setup(withBoundRun = true): void {
    ;({ db, runtime, ctx } = h.setup(withBoundRun))
  }

  afterEach(() => {
    h.cleanup()
  })

  async function call(name: string, params: Record<string, unknown>) {
    return h.call(name, params, ctx)
  }

  it('registers all expected methods', () => {
    const registry = buildRegistry(ORCHESTRATION_METHODS)
    expect(registry.size).toBe(39)
    expect(registry.has('orchestration.workerRelease')).toBe(true)
    expect(registry.has('orchestration.workerRetain')).toBe(true)
    expect(registry.has('orchestration.workerList')).toBe(true)
    expect(registry.has('orchestration.workerTerminalUserInput')).toBe(true)
    expect(registry.has('orchestration.runCreate')).toBe(true)
    expect(registry.has('orchestration.runUse')).toBe(true)
    expect(registry.has('orchestration.runCurrent')).toBe(true)
    expect(registry.has('orchestration.runList')).toBe(true)
    expect(registry.has('orchestration.runShow')).toBe(true)
    expect(registry.has('orchestration.send')).toBe(true)
    expect(registry.has('orchestration.check')).toBe(true)
    expect(registry.has('orchestration.reply')).toBe(true)
    expect(registry.has('orchestration.inbox')).toBe(true)
    expect(registry.has('orchestration.taskCreate')).toBe(true)
    expect(registry.has('orchestration.taskList')).toBe(true)
    expect(registry.has('orchestration.taskUpdate')).toBe(true)
    expect(registry.has('orchestration.dispatch')).toBe(true)
    expect(registry.has('orchestration.dispatchShow')).toBe(true)
    expect(registry.has('orchestration.workerStart')).toBe(true)
    expect(registry.has('orchestration.workerShow')).toBe(true)
    expect(registry.has('orchestration.workerRead')).toBe(true)
    expect(registry.has('orchestration.workerStop')).toBe(true)
    expect(registry.has('orchestration.workerAbandon')).toBe(true)
    expect(registry.has('orchestration.federationAttachStart')).toBe(true)
    expect(registry.has('orchestration.federationPull')).toBe(true)
    expect(registry.has('orchestration.federationAck')).toBe(true)
    expect(registry.has('orchestration.federationImport')).toBe(true)
    expect(registry.has('orchestration.federationShow')).toBe(true)
    expect(registry.has('orchestration.federationRead')).toBe(true)
    expect(registry.has('orchestration.federationReadOutput')).toBe(true)
    expect(registry.has('orchestration.federationStop')).toBe(true)
    expect(registry.has('orchestration.ask')).toBe(true)
    expect(registry.has('orchestration.run')).toBe(true)
    expect(registry.has('orchestration.runStop')).toBe(true)
    expect(registry.has('orchestration.gateCreate')).toBe(true)
    expect(registry.has('orchestration.gateResolve')).toBe(true)
    expect(registry.has('orchestration.gateList')).toBe(true)
    expect(registry.has('orchestration.requestShow')).toBe(true)
    expect(registry.has('orchestration.reset')).toBe(true)
  })

  describe('lightweight Runs', () => {
    it('creates and binds a Run to the runtime-resolved caller pane', async () => {
      setup(false)
      vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue(
        'tab_coord:11111111-1111-4111-8111-111111111111'
      )

      const created = (await call('orchestration.runCreate', {
        objective: 'Coordinate reviews',
        from: 'term_coord'
      })) as { run: { id: string; consumer_generation: number } }
      const current = (await call('orchestration.runCurrent', { from: 'term_coord' })) as {
        run: { id: string } | null
      }

      expect(created.run.consumer_generation).toBe(1)
      expect(current.run?.id).toBe(created.run.id)
    })

    it('requires runtime-observed stable pane identity for binding', async () => {
      setup(false)
      vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue(null)

      await expect(
        call('orchestration.runCreate', { objective: 'No pane', from: 'term_stale' })
      ).rejects.toMatchObject({ code: 'stable_pane_required' })
      expect(db.listRuns().runs.filter((run) => run.legacy === 0)).toHaveLength(0)
    })

    it('rebinds explicitly, lists Runs, and keeps the legacy Run inspect-only', async () => {
      setup(false)
      vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
        handle === 'term_old'
          ? 'tab_old:11111111-1111-4111-8111-111111111111'
          : 'tab_new:22222222-2222-4222-9222-222222222222'
      )
      const created = (await call('orchestration.runCreate', {
        objective: 'Move me',
        from: 'term_old'
      })) as { run: { id: string } }
      const rebound = (await call('orchestration.runUse', {
        id: created.run.id,
        from: 'term_new'
      })) as { run: { consumer_generation: number } }
      const listed = (await call('orchestration.runList', {})) as {
        runs: { id: string; legacy: number }[]
      }

      expect(rebound.run.consumer_generation).toBe(2)
      expect(listed.runs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: created.run.id, legacy: 0 }),
          expect.objectContaining({ id: 'run_legacy_local', legacy: 1 })
        ])
      )
      await expect(
        call('orchestration.runUse', { id: 'run_legacy_local', from: 'term_new' })
      ).rejects.toMatchObject({ code: 'run_not_found' })
    })

    it('requires an explicit binding before task mutation', async () => {
      setup(false)
      vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue(coordinatorPaneKey)

      await expect(
        call('orchestration.taskCreate', {
          spec: 'must not become global',
          callerTerminalHandle: 'term_coord'
        })
      ).rejects.toMatchObject({
        code: 'run_required',
        data: {
          effectsApplied: false,
          nextCommandArgs: ['skills', 'get', 'orchestration', '--full']
        }
      })
      expect(db.listTasks()).toHaveLength(0)
    })

    it('scopes task listing and fences the old coordinator after run-use', async () => {
      setup(false)
      const oldPane = 'tab_old:11111111-1111-4111-8111-111111111111'
      const newPane = 'tab_new:22222222-2222-4222-9222-222222222222'
      vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
        handle === 'term_old' ? oldPane : newPane
      )
      const runA = db.createRun({
        objective: 'A',
        coordinatorHandle: 'term_old',
        coordinatorPaneKey: oldPane
      })
      const runB = db.createRun({
        objective: 'B',
        coordinatorHandle: 'term_other',
        coordinatorPaneKey: newPane
      })
      const taskA = db.createTask({ spec: 'A work', runId: runA.id })
      db.createTask({ spec: 'B work', runId: runB.id })

      const listed = (await call('orchestration.taskList', { run: runA.id })) as {
        tasks: { id: string }[]
      }
      expect(listed.tasks.map((task) => task.id)).toEqual([taskA.id])

      db.bindRun({
        runId: runA.id,
        coordinatorHandle: 'term_new',
        coordinatorPaneKey: newPane
      })
      await expect(
        call('orchestration.taskCreate', {
          spec: 'stale write',
          run: runA.id,
          callerTerminalHandle: 'term_old'
        })
      ).rejects.toMatchObject({ code: 'consumer_fenced' })
    })

    it('cancels and fences the old Run waiter when run-use rebinds', async () => {
      setup(false)
      const oldPane = 'tab_old:11111111-1111-4111-8111-111111111111'
      const newPane = 'tab_new:22222222-2222-4222-9222-222222222222'
      vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
        handle === 'term_old' ? oldPane : newPane
      )
      const created = (await call('orchestration.runCreate', {
        objective: 'Wait fencing',
        from: 'term_old'
      })) as { run: { id: string } }
      const oldWait = call('orchestration.check', {
        terminal: 'term_old',
        wait: true,
        timeoutMs: 5_000
      })
      const fenced = expect(oldWait).rejects.toMatchObject({ code: 'consumer_fenced' })
      await Promise.resolve()

      await call('orchestration.runUse', {
        id: created.run.id,
        from: 'term_new'
      })

      await fenced
    })

    it('fences an unbound direct waiter when its pane creates a Run', async () => {
      setup(false)
      vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue(coordinatorPaneKey)
      const directWait = call('orchestration.check', {
        terminal: 'term_coord',
        wait: true,
        timeoutMs: 5_000
      })
      const fenced = expect(directWait).rejects.toMatchObject({ code: 'consumer_fenced' })
      await Promise.resolve()

      await call('orchestration.runCreate', {
        objective: 'Claim the direct mailbox',
        from: 'term_coord'
      })

      await fenced
    })
  })

  describe('orchestration.reset', () => {
    function seedResetState(): void {
      db.insertMessage({ from: 'a', to: 'b', subject: 'test' })
      db.createTask({ spec: 'work' })
    }

    it('resets all state', async () => {
      setup()
      seedResetState()
      const stopRelay = vi.spyOn(runtime, 'stopOrchestrationFederationRelay')

      const result = (await call('orchestration.reset', { all: true })) as { reset: string }
      expect(result.reset).toBe('all')
      expect(stopRelay).toHaveBeenCalledOnce()
      expect(db.getInbox()).toHaveLength(0)
      expect(db.listTasks()).toHaveLength(0)
    })

    it('resets tasks only', async () => {
      setup()
      seedResetState()
      const stopRelay = vi.spyOn(runtime, 'stopOrchestrationFederationRelay')

      await call('orchestration.reset', { tasks: true })
      expect(stopRelay).toHaveBeenCalledOnce()
      expect(db.getInbox()).toHaveLength(1)
      expect(db.listTasks()).toHaveLength(0)
    })

    it('resets messages only', async () => {
      setup()
      seedResetState()
      const stopRelay = vi.spyOn(runtime, 'stopOrchestrationFederationRelay')

      await call('orchestration.reset', { messages: true })
      expect(stopRelay).not.toHaveBeenCalled()
      expect(db.getInbox()).toHaveLength(0)
      expect(db.listTasks()).toHaveLength(1)
    })

    it.each([
      ['empty params', {}],
      ['false-only params', { all: false }],
      ['multi-scope task and messages params', { tasks: true, messages: true }],
      ['multi-scope all and tasks params', { all: true, tasks: true }],
      ['non-boolean params', { all: 'true' }]
    ])('rejects %s without mutating state', async (_name, params) => {
      setup()
      seedResetState()

      await expect(call('orchestration.reset', params)).rejects.toThrow()
      expect(db.getInbox()).toHaveLength(1)
      expect(db.listTasks()).toHaveLength(1)
    })

    it('ignores false scopes when exactly one scope is true', async () => {
      setup()
      seedResetState()

      const result = (await call('orchestration.reset', { all: false, tasks: true })) as {
        reset: string
      }

      expect(result.reset).toBe('tasks')
      expect(db.getInbox()).toHaveLength(1)
      expect(db.listTasks()).toHaveLength(0)
    })

    it('ignores non-boolean scopes when exactly one real boolean scope is true', async () => {
      setup()
      seedResetState()

      const result = (await call('orchestration.reset', { all: 'true', messages: true })) as {
        reset: string
      }

      expect(result.reset).toBe('messages')
      expect(db.getInbox()).toHaveLength(0)
      expect(db.listTasks()).toHaveLength(1)
    })
  })
})
