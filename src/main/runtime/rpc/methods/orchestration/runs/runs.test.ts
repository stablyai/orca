import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildRegistry, type RpcContext } from '../../../core'
import { ORCHESTRATION_METHODS } from '../../orchestration'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'

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

  function seedCurrentCoordinatorLease(runId: string) {
    const lease = db.reserveMaestroTerminalLease({
      requestId: `coordinator:${runId}:g1`,
      executionHostId: 'local',
      workspaceKey: 'folder:one',
      runId,
      coordinatorGeneration: 1,
      role: 'coordinator',
      coordinatorRunId: runId,
      title: 'Current coordinator',
      launchProfile: {
        agent: 'codex',
        model: null,
        effort: null,
        permissionMode: 'default',
        routeRef: null
      },
      spawnedBy: 'coordinator:g1',
      ownerPrincipal: 'coordinator:g1',
      retentionPolicy: 'retain'
    })
    db.attachMaestroTerminalLease({
      leaseId: lease.id,
      terminalHandle: 'term_coord',
      tabId: 'tab_coord',
      paneKey: coordinatorPaneKey,
      ptyIncarnation: 'runtime_test:term_coord:1',
      processRootId: 'runtime_test:term_coord'
    })
    db.retainMaestroTerminalLease(lease.id)
    return lease
  }

  function coordinatorHandoffParams(runId: string) {
    const capsule = 'continue the Run'
    return {
      operation: 'start',
      requestId: 'handoff:restart',
      runId,
      from: 'term_coord',
      worktree: 'folder:one',
      capsule,
      capsuleDigest: `sha256:${createHash('sha256').update(capsule).digest('hex')}`,
      inputIdempotencyKey: 'handoff:restart:input',
      expectedGraphRevision: 1,
      agent: 'codex'
    }
  }

  it('registers all expected methods', () => {
    const registry = buildRegistry(ORCHESTRATION_METHODS)
    expect(registry.size).toBe(45)
    expect(registry.has('orchestration.coordinatorHandoff')).toBe(true)
    expect(registry.has('orchestration.workerRelease')).toBe(true)
    expect(registry.has('orchestration.workerRetain')).toBe(true)
    expect(registry.has('orchestration.workerList')).toBe(true)
    expect(registry.has('orchestration.workerCleanup')).toBe(false)
    expect(registry.has('orchestration.workerTerminalUserInput')).toBe(true)
    expect(registry.has('orchestration.runCreate')).toBe(true)
    expect(registry.has('orchestration.runUse')).toBe(true)
    expect(registry.has('orchestration.runCurrent')).toBe(true)
    expect(registry.has('orchestration.runList')).toBe(true)
    expect(registry.has('orchestration.runShow')).toBe(true)
    expect(registry.has('orchestration.runSettle')).toBe(true)
    expect(registry.has('orchestration.runComplete')).toBe(true)
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
    expect(registry.has('orchestration.federationFleetSnapshot')).toBe(true)
    expect(registry.has('orchestration.federationRelease')).toBe(true)
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
    it('settles only the Run currently owned by the authenticated coordinator', async () => {
      setup()
      const run = db.getCurrentRunForPane(coordinatorPaneKey)
      const settle = vi.spyOn(runtime, 'settleOrchestrationRun').mockResolvedValue({
        runId: run?.id ?? '',
        state: 'settled',
        worktrees: [],
        warnings: []
      })

      const result = await call('orchestration.runSettle', {
        id: run?.id,
        from: 'term_coord'
      })

      expect(result).toMatchObject({ runId: run?.id, state: 'settled' })
      expect(settle).toHaveBeenCalledWith(run?.id)
      await expect(
        call('orchestration.runSettle', { id: 'run_foreign', from: 'term_coord' })
      ).rejects.toMatchObject({ code: 'run_not_found' })
    })

    it('completes explicitly and replays the same completion idempotently', async () => {
      setup()
      const run = db.getCurrentRunForPane(coordinatorPaneKey)!
      const task = db.createTask({ spec: 'Ship the required change' })
      db.updateTaskStatus(task.id, 'completed', 'Verified')
      const params = {
        id: run.id,
        from: 'term_coord',
        summary: 'Shipped the verified change.',
        evidence: ['pnpm test: passed']
      }

      const first = (await call('orchestration.runComplete', params)) as {
        completion: { completed_by_generation: number }
        duplicate: boolean
      }
      const replay = (await call('orchestration.runComplete', params)) as {
        duplicate: boolean
      }
      const shown = (await call('orchestration.runShow', { id: run.id })) as {
        run: { completion?: { summary: string } }
      }

      expect(first).toMatchObject({
        duplicate: false,
        completion: { completed_by_generation: run.consumer_generation }
      })
      expect(replay.duplicate).toBe(true)
      expect(shown.run.completion?.summary).toBe('Shipped the verified change.')
    })

    it('blocks unresolved required work unless every Task has a reasoned waiver', async () => {
      setup()
      const run = db.getCurrentRunForPane(coordinatorPaneKey)!
      const required = db.createTask({ spec: 'Required review' })
      db.createTask({ spec: 'Optional cleanup probe', purpose: 'operational' })
      const base = {
        id: run.id,
        from: 'term_coord',
        summary: 'Closed with an explicit scope decision.',
        evidence: ['Reviewed the remaining scope.']
      }

      await expect(call('orchestration.runComplete', base)).rejects.toMatchObject({
        code: 'run_incomplete',
        data: { blockingTaskIds: [required.id], effectsApplied: false }
      })
      const result = await call('orchestration.runComplete', {
        ...base,
        waivers: [{ task_id: required.id, reason: 'Owner deferred it to a follow-up.' }]
      })

      expect(result).toMatchObject({
        completion: {
          waivers: [{ task_id: required.id, reason: 'Owner deferred it to a follow-up.' }]
        }
      })
      expect(db.getTask(required.id)?.status).toBe('ready')
    })

    it('completes while preserving an unverifiable resource as a separate warning', async () => {
      setup()
      const run = db.getCurrentRunForPane(coordinatorPaneKey)!
      const required = db.createTask({ spec: 'Verified deliverable' })
      db.updateTaskStatus(required.id, 'completed', 'Passed')
      const lease = db.reserveMaestroTerminalLease({
        requestId: 'worker:unverifiable',
        executionHostId: 'ssh:worker-host',
        workspaceKey: 'folder:remote',
        runId: run.id,
        taskId: required.id,
        attemptId: 'attempt:unverifiable',
        role: 'worker',
        title: 'Unverifiable worker',
        launchProfile: {
          agent: 'codex',
          model: null,
          effort: null,
          permissionMode: 'default',
          routeRef: null
        },
        spawnedBy: 'coordinator',
        ownerPrincipal: 'dispatch:unverifiable',
        retentionPolicy: 'auto_release'
      })
      db.db
        .prepare(
          "UPDATE maestro_terminal_leases SET lifecycle_state = 'outcome_unknown' WHERE id = ?"
        )
        .run(lease.id)

      await expect(
        call('orchestration.runComplete', {
          id: run.id,
          from: 'term_coord',
          summary: 'Required work is complete.',
          evidence: ['Deliverable test passed.']
        })
      ).resolves.toMatchObject({ duplicate: false })
      expect(db.getMaestroTerminalLease(lease.id)?.lifecycleState).toBe('outcome_unknown')
    })

    it('rejects a stale coordinator generation without persisting completion', async () => {
      setup()
      const run = db.getCurrentRunForPane(coordinatorPaneKey)!
      db.bindRun({
        runId: run.id,
        coordinatorHandle: 'term_replacement',
        coordinatorPaneKey: 'tab_replacement:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      })

      await expect(
        call('orchestration.runComplete', {
          id: run.id,
          from: 'term_coord',
          summary: 'Stale completion.',
          evidence: ['No current authority.']
        })
      ).rejects.toMatchObject({ code: 'consumer_fenced' })
      expect(db.getRunCompletion(run.id)).toBeUndefined()
    })

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

    it('publishes a run receipt without internal routing columns', async () => {
      setup(false)
      vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue(
        'tab_coord:11111111-1111-4111-8111-111111111111'
      )

      const created = (await call('orchestration.runCreate', {
        objective: 'Coordinate reviews',
        from: 'term_coord'
      })) as { run: Record<string, unknown> }

      expect(created.run).not.toHaveProperty('coordinator_pane_key')
      expect(created.run).not.toHaveProperty('home_database')
      expect(created.run.consumer_generation).toBe(1)
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

    it('re-adopts the authenticated current coordinator lease after a runtime restart', async () => {
      setup()
      const run = db.getCurrentRunForPane(coordinatorPaneKey)
      const processIncarnation = 'folder:coordinator@@pty:incarnation-1'
      vi.spyOn(runtime, 'showTerminal').mockResolvedValue({
        handle: 'term_coord',
        ptyId: 'folder:coordinator@@pty',
        tabId: 'tab_coord',
        agentIdentity: 'codex'
      } as never)
      vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue(processIncarnation)
      vi.spyOn(runtime, 'buildTerminalManagedCliContext').mockReturnValue({
        executionHostId: 'local',
        workspaceKey: 'folder:coordinator'
      } as never)
      ctx = {
        runtime,
        orchestrationCompatibilityCallerAuthority: {
          hostScope: { kind: 'local', hostId: 'local' },
          terminalHandle: 'term_coord',
          paneKey: coordinatorPaneKey,
          processIncarnation,
          launchTokenHash: 'authenticated-launch-token-hash'
        }
      }

      const rebound = (await call('orchestration.runUse', {
        id: run?.id,
        from: 'term_coord'
      })) as { run: { consumer_generation: number } }

      expect(rebound.run.consumer_generation).toBe(1)
      expect(db.getCoordinatorLease(run!.id, 1)).toMatchObject({
        terminalHandle: 'term_coord',
        paneKey: coordinatorPaneKey,
        ptyIncarnation: processIncarnation,
        executionHostId: 'local',
        workspaceKey: 'folder:coordinator',
        lifecycleState: 'retained'
      })
    })

    it('rejects a coordinator handoff lease rebind without authenticated caller authority', async () => {
      setup()
      const run = db.getCurrentRunForPane(coordinatorPaneKey)!
      const lease = seedCurrentCoordinatorLease(run.id)
      vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
        id: 'folder:one',
        hostId: 'local'
      } as never)
      vi.spyOn(runtime, 'getClientSettings').mockReturnValue({} as never)
      vi.spyOn(runtime, 'showTerminal').mockResolvedValue({
        handle: 'term_coord',
        tabId: 'tab_coord',
        ptyId: 'runtime_test:term_coord',
        agentIdentity: 'codex'
      } as never)
      vi.spyOn(runtime, 'buildTerminalManagedCliContext').mockReturnValue({
        executionHostId: 'local',
        workspaceKey: 'folder:one'
      } as never)

      await expect(
        call('orchestration.coordinatorHandoff', coordinatorHandoffParams(run.id))
      ).rejects.toMatchObject({ code: 'consumer_fenced' })
      expect(db.getCoordinatorHandoff('handoff:restart')).toBeUndefined()
      expect(db.getMaestroTerminalLease(lease.id)).toMatchObject({
        terminalHandle: 'term_coord',
        ptyIncarnation: 'runtime_test:term_coord:1'
      })
    })

    it('replays a reserved coordinator handoff without rebinding its successor lease', async () => {
      setup()
      const run = db.getCurrentRunForPane(coordinatorPaneKey)!
      const predecessor = seedCurrentCoordinatorLease(run.id)
      const params = coordinatorHandoffParams(run.id)
      const reserved = db.reserveCoordinatorHandoff({
        requestId: params.requestId,
        runId: run.id,
        executionHostId: 'local',
        workspaceKey: 'folder:one',
        title: 'Successor coordinator',
        launchProfile: predecessor.launchProfile,
        spawnedBy: 'coordinator:g1',
        ownerPrincipal: 'coordinator:g2',
        capsuleDigest: params.capsuleDigest,
        inputIdempotencyKey: params.inputIdempotencyKey,
        expectedGraphRevision: params.expectedGraphRevision,
        retentionPolicy: 'auto_release'
      })
      db.blockCoordinatorHandoff({
        requestId: params.requestId,
        phase: 'blocked',
        code: 'launch_profile_drift'
      })
      const callerAuthority = {
        hostScope: { kind: 'local', hostId: 'local' },
        terminalHandle: 'term_coord',
        paneKey: coordinatorPaneKey,
        processIncarnation: 'runtime_test:term_coord:1',
        launchTokenHash: 'authenticated-launch-token-hash'
      } as const
      vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockReturnValue(callerAuthority)
      vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
        id: 'folder:one',
        hostId: 'local'
      } as never)
      vi.spyOn(runtime, 'getClientSettings').mockReturnValue({} as never)
      const showTerminal = vi.spyOn(runtime, 'showTerminal')
      ctx = { runtime, orchestrationCompatibilityCallerAuthority: callerAuthority }

      const replayed = (await call('orchestration.coordinatorHandoff', params)) as {
        handoff: { phase: string; successorLeaseId: string }
      }

      expect(replayed.handoff).toMatchObject({
        phase: 'blocked',
        successorLeaseId: reserved.successorLeaseId
      })
      expect(showTerminal).not.toHaveBeenCalled()
      expect(db.getMaestroTerminalLease(reserved.successorLeaseId)).toMatchObject({
        terminalHandle: null,
        ptyIncarnation: null
      })
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
