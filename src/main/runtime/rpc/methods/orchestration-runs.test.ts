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
    expect(registry.size).toBe(38)
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
      const transientPaneKey = 'tab_stale:33333333-3333-4333-8333-333333333333'
      vi.spyOn(runtime, 'getTerminalPaneKey')
        .mockReturnValueOnce(transientPaneKey)
        .mockReturnValueOnce(transientPaneKey)
        .mockReturnValue(null)

      await expect(
        call('orchestration.runCreate', { objective: 'No pane', from: 'term_stale' })
      ).rejects.toMatchObject({ code: 'stable_pane_required' })
      expect(db.listRuns().runs.filter((run) => run.legacy === 0)).toHaveLength(0)
    })

    it('refuses to replace a live coordinator and keeps the legacy Run inspect-only', async () => {
      setup(false)
      vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
        handle === 'term_old'
          ? 'tab_old:11111111-1111-4111-8111-111111111111'
          : 'tab_new:22222222-2222-4222-9222-222222222222'
      )
      vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation((handle) => ({
        runtimeId: 'runtime_test',
        terminalHandle: handle,
        ptyId: handle,
        worktreeId: 'folder:workspace',
        processIncarnation: `runtime_test:${handle}:1`,
        paneKey:
          handle === 'term_old'
            ? 'tab_old:11111111-1111-4111-8111-111111111111'
            : 'tab_new:22222222-2222-4222-9222-222222222222',
        launchTokenHash: null,
        hostScope: { kind: 'local', hostId: 'local' }
      }))
      const created = (await call('orchestration.runCreate', {
        objective: 'Move me',
        from: 'term_old'
      })) as { run: { id: string } }
      vi.spyOn(runtime, 'inspectTerminalProcessIncarnationLiveness').mockResolvedValue('live')
      await expect(
        call('orchestration.runUse', {
          id: created.run.id,
          from: 'term_new'
        })
      ).rejects.toMatchObject({
        code: 'consumer_fenced',
        data: {
          effectsApplied: false,
          coordinatorStatus: 'live',
          inspectCommandArgs: ['orchestration', 'run-show', '--id', created.run.id, '--json'],
          retryCommandArgs: ['orchestration', 'run-use', '--id', created.run.id, '--json'],
          nextSteps: [
            expect.stringContaining('owning coordinator terminal'),
            expect.stringContaining('stop or exit that coordinator process'),
            expect.stringContaining(`run-show --id ${created.run.id} --json`),
            expect.stringContaining('No force-steal exists for an ordinary Run')
          ]
        }
      })
      const inspected = (await call('orchestration.taskList', {
        run: created.run.id,
        callerTerminalHandle: 'term_new'
      })) as { binding: { currentConsumer: boolean } }
      const shown = (await call('orchestration.runShow', {
        id: created.run.id,
        from: 'term_new'
      })) as { binding: { currentConsumer: boolean } }
      const headlessShown = (await call('orchestration.runShow', {
        id: created.run.id
      })) as { binding: { currentConsumer: boolean } }
      const headlessTasks = (await call('orchestration.taskList', {
        run: created.run.id
      })) as { binding: { currentConsumer: boolean } }
      const listed = (await call('orchestration.runList', {})) as {
        runs: { id: string; legacy: number; consumer_generation: number }[]
      }

      expect(inspected.binding.currentConsumer).toBe(false)
      expect(shown.binding.currentConsumer).toBe(false)
      expect(headlessShown.binding.currentConsumer).toBe(false)
      expect(headlessTasks.binding.currentConsumer).toBe(false)
      expect(listed.runs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: created.run.id, legacy: 0, consumer_generation: 1 }),
          expect.objectContaining({ id: 'run_legacy_local', legacy: 1 })
        ])
      )
      await expect(
        call('orchestration.runUse', { id: 'run_legacy_local', from: 'term_new' })
      ).rejects.toMatchObject({ code: 'run_not_found' })
    })

    it('refuses replacement when a migrated incumbent is not provably exited', async () => {
      setup(false)
      const oldPane = 'tab_old:11111111-1111-4111-8111-111111111111'
      vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue(oldPane)
      vi.spyOn(runtime, 'getLiveTerminalPaneKey').mockImplementation((handle) =>
        handle === 'term_new' ? oldPane : null
      )
      const run = db.createRun({
        objective: 'Migrated disconnected owner',
        coordinatorHandle: 'term_old',
        coordinatorPaneKey: oldPane
      })
      db.db.prepare('UPDATE runs SET coordinator_authority_revision = -1 WHERE id = ?').run(run.id)

      await expect(
        call('orchestration.taskCreate', {
          spec: 'replacement write',
          run: run.id,
          callerTerminalHandle: 'term_new'
        })
      ).rejects.toMatchObject({ code: 'consumer_fenced' })
      await expect(
        call('orchestration.runUse', { id: run.id, from: 'term_new' })
      ).rejects.toMatchObject({
        code: 'consumer_fenced',
        data: {
          effectsApplied: false,
          coordinatorStatus: 'unverifiable',
          inspectCommandArgs: ['orchestration', 'run-show', '--id', run.id, '--json'],
          retryCommandArgs: ['orchestration', 'run-use', '--id', run.id, '--json'],
          nextSteps: expect.arrayContaining([
            expect.stringContaining('Restore connectivity to the owning host'),
            expect.stringContaining('Loss of contact is not evidence of exit'),
            expect.stringContaining(`run-show --id ${run.id} --json`),
            expect.stringContaining('only after the owning host proves the incumbent exited')
          ])
        }
      })
    })

    it('does not grant a migrated binding to a replacement incarnation on the same handle', async () => {
      setup(false)
      const pane = 'tab_old:11111111-1111-4111-8111-111111111111'
      vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue(pane)
      vi.spyOn(runtime, 'getLiveTerminalPaneKey').mockReturnValue(pane)
      vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockReturnValue({
        runtimeId: 'runtime_test',
        terminalHandle: 'term_old',
        ptyId: 'pty_replacement',
        worktreeId: 'folder:workspace',
        processIncarnation: 'pty_replacement:incarnation-2',
        paneKey: pane,
        launchTokenHash: 'replacement-launch',
        hostScope: { kind: 'local', hostId: 'local' }
      })
      const run = db.createRun({
        objective: 'Migrated same-handle owner',
        coordinatorHandle: 'term_old',
        coordinatorPaneKey: pane
      })
      db.db.prepare('UPDATE runs SET coordinator_authority_revision = -1 WHERE id = ?').run(run.id)

      await expect(
        call('orchestration.runUse', { id: run.id, from: 'term_old' })
      ).rejects.toMatchObject({
        code: 'consumer_fenced',
        data: { effectsApplied: false, coordinatorStatus: 'live' }
      })
      expect(db.getRun(run.id)).toMatchObject({
        coordinator_handle: 'term_old',
        coordinator_process_incarnation: null,
        consumer_generation: run.consumer_generation
      })
    })

    it('backfills an exact migrated handle only from restored process authority', async () => {
      setup(false)
      const pane = 'tab_old:11111111-1111-4111-8111-111111111111'
      const processIncarnation = 'pty_retained:incarnation-1'
      vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue(pane)
      vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockReturnValue({
        runtimeId: 'runtime_test',
        terminalHandle: 'term_old',
        ptyId: 'pty_retained',
        worktreeId: 'folder:workspace',
        processIncarnation,
        paneKey: pane,
        launchTokenHash: null,
        hostScope: { kind: 'local', hostId: 'local' }
      })
      ctx = {
        runtime,
        orchestrationCompatibilityEvidence: {
          terminalHandle: 'term_old',
          paneKey: pane,
          launchToken: 'retained-launch'
        }
      }
      let attestedProcessIncarnation = 'pty_retained:incarnation-stale'
      let verificationCount = 0
      let dropAttestationAfterFirstVerification = false
      vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockImplementation(() => {
        verificationCount += 1
        return dropAttestationAfterFirstVerification && verificationCount > 1
          ? null
          : {
              terminalHandle: 'term_old',
              paneKey: pane,
              processIncarnation: attestedProcessIncarnation,
              launchTokenHash: 'retained-launch-hash',
              hostScope: { kind: 'local', hostId: 'local' },
              terminalProvenance: 'restored'
            }
      })
      const run = db.createRun({
        objective: 'Migrated retained owner',
        coordinatorHandle: 'term_old',
        coordinatorPaneKey: pane
      })
      db.db.prepare('UPDATE runs SET coordinator_authority_revision = -1 WHERE id = ?').run(run.id)

      await expect(
        call('orchestration.runUse', { id: run.id, from: 'term_old' })
      ).rejects.toMatchObject({ code: 'consumer_fenced' })
      attestedProcessIncarnation = processIncarnation
      verificationCount = 0
      dropAttestationAfterFirstVerification = true

      await expect(
        call('orchestration.runUse', { id: run.id, from: 'term_old' })
      ).rejects.toMatchObject({ code: 'consumer_fenced' })
      verificationCount = 0
      dropAttestationAfterFirstVerification = false

      const rebound = (await call('orchestration.runUse', {
        id: run.id,
        from: 'term_old'
      })) as { run: { consumer_generation: number; coordinator_process_incarnation: string } }

      expect(rebound.run).toMatchObject({
        consumer_generation: run.consumer_generation,
        coordinator_process_incarnation: processIncarnation
      })
    })

    it('recovers a migrated binding after the resolved incumbent process is proven exited', async () => {
      setup(false)
      const oldPane = 'tab_old:11111111-1111-4111-8111-111111111111'
      const newPane = 'tab_new:22222222-2222-4222-9222-222222222222'
      vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
        handle === 'term_old' ? oldPane : newPane
      )
      vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation((handle) => ({
        runtimeId: 'runtime_test',
        terminalHandle: handle,
        ptyId: handle,
        worktreeId: 'folder:workspace',
        processIncarnation: `${handle}:incarnation-1`,
        paneKey: handle === 'term_old' ? oldPane : newPane,
        launchTokenHash: null,
        hostScope: { kind: 'local', hostId: 'local' }
      }))
      const run = db.createRun({
        objective: 'Migrated exited owner',
        coordinatorHandle: 'term_old',
        coordinatorPaneKey: oldPane
      })
      db.db.prepare('UPDATE runs SET coordinator_authority_revision = -1 WHERE id = ?').run(run.id)
      vi.spyOn(runtime, 'inspectTerminalProcessIncarnationLiveness').mockResolvedValue('exited')

      const rebound = (await call('orchestration.runUse', {
        id: run.id,
        from: 'term_new'
      })) as { run: { coordinator_handle: string; consumer_generation: number } }

      expect(rebound.run).toMatchObject({
        coordinator_handle: 'term_new',
        consumer_generation: run.consumer_generation + 1
      })
    })

    it('backfills a migrated binding when a reminted handle resolves to the same process', async () => {
      setup(false)
      const oldPane = 'tab_old:11111111-1111-4111-8111-111111111111'
      const remintedPane = 'tab_new:11111111-1111-4111-8111-111111111111'
      vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
        handle === 'term_old' ? oldPane : remintedPane
      )
      vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation((handle) => ({
        runtimeId: 'runtime_test',
        terminalHandle: handle,
        ptyId: 'pty_coord',
        worktreeId: 'folder:workspace',
        processIncarnation: 'pty_coord:incarnation-1',
        paneKey: handle === 'term_old' ? oldPane : remintedPane,
        launchTokenHash: null,
        hostScope: { kind: 'local', hostId: 'local' }
      }))
      const run = db.createRun({
        objective: 'Migrated live owner',
        coordinatorHandle: 'term_old',
        coordinatorPaneKey: oldPane
      })

      const rebound = (await call('orchestration.runUse', {
        id: run.id,
        from: 'term_reminted'
      })) as { run: { coordinator_handle: string; consumer_generation: number } }

      expect(rebound.run).toMatchObject({
        coordinator_handle: 'term_reminted',
        consumer_generation: run.consumer_generation
      })
    })

    it('preserves the consumer generation when the same process remints its handle and pane', async () => {
      setup(false)
      const oldPane = 'tab_old:11111111-1111-4111-8111-111111111111'
      const remintedPane = 'tab_new:11111111-1111-4111-8111-111111111111'
      vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
        handle === 'term_old' ? oldPane : remintedPane
      )
      vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation((handle) => ({
        runtimeId: 'runtime_test',
        terminalHandle: handle,
        ptyId: 'pty_coord',
        worktreeId: 'folder:workspace',
        processIncarnation: 'pty_coord:incarnation-1',
        paneKey: handle === 'term_old' ? oldPane : remintedPane,
        launchTokenHash: null,
        hostScope: { kind: 'local', hostId: 'local' }
      }))
      const created = (await call('orchestration.runCreate', {
        objective: 'Survive remint',
        from: 'term_old'
      })) as { run: { id: string; consumer_generation: number } }

      const rebound = (await call('orchestration.runUse', {
        id: created.run.id,
        from: 'term_reminted'
      })) as { run: { coordinator_handle: string; consumer_generation: number } }

      expect(rebound.run).toMatchObject({
        coordinator_handle: 'term_reminted',
        consumer_generation: created.run.consumer_generation
      })
    })

    it('does not grant Run authority to a replacement process in the same pane', async () => {
      setup(false)
      const pane = 'tab_coord:11111111-1111-4111-8111-111111111111'
      vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue(pane)
      vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation((handle) => ({
        runtimeId: 'runtime_test',
        terminalHandle: handle,
        ptyId: handle,
        worktreeId: 'folder:workspace',
        processIncarnation: `${handle}:incarnation-1`,
        paneKey: pane,
        launchTokenHash: null,
        hostScope: { kind: 'local', hostId: 'local' }
      }))
      const created = (await call('orchestration.runCreate', {
        objective: 'Keep incumbent authority',
        from: 'term_old'
      })) as { run: { id: string } }

      await expect(
        call('orchestration.taskCreate', {
          spec: 'replacement write',
          run: created.run.id,
          callerTerminalHandle: 'term_new'
        })
      ).rejects.toMatchObject({ code: 'consumer_fenced' })

      vi.spyOn(runtime, 'inspectTerminalProcessIncarnationLiveness').mockResolvedValue('live')
      await expect(
        call('orchestration.runUse', { id: created.run.id, from: 'term_new' })
      ).rejects.toMatchObject({
        code: 'consumer_fenced',
        data: { effectsApplied: false, coordinatorStatus: 'live' }
      })

      await expect(
        call('orchestration.runCreate', {
          objective: 'Must not evict the live owner',
          from: 'term_new'
        })
      ).rejects.toMatchObject({ code: 'consumer_fenced', data: { effectsApplied: false } })
      expect(db.getRun(created.run.id)).toMatchObject({
        coordinator_handle: 'term_old',
        consumer_generation: 1
      })

      const unboundTarget = db.createRun({
        objective: 'Unbound target',
        coordinatorHandle: 'term_target',
        coordinatorPaneKey: 'tab_target:33333333-3333-4333-8333-333333333333'
      })
      db.db
        .prepare(
          `UPDATE runs
           SET coordinator_handle = NULL, coordinator_pane_key = NULL,
               coordinator_process_incarnation = NULL, coordinator_host_scope = NULL
           WHERE id = ?`
        )
        .run(unboundTarget.id)
      await expect(
        call('orchestration.runUse', { id: unboundTarget.id, from: 'term_new' })
      ).rejects.toMatchObject({ code: 'consumer_fenced', data: { effectsApplied: false } })
      expect(db.getRun(created.run.id)).toMatchObject({
        coordinator_handle: 'term_old',
        consumer_generation: 1
      })
    })

    it('allows a distinct coordinator only after the owning host proves the incumbent exited', async () => {
      setup(false)
      const oldPane = 'tab_old:11111111-1111-4111-8111-111111111111'
      const newPane = 'tab_new:22222222-2222-4222-9222-222222222222'
      vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
        handle === 'term_old' ? oldPane : newPane
      )
      vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation((handle) => ({
        runtimeId: 'runtime_test',
        terminalHandle: handle,
        ptyId: handle,
        worktreeId: 'folder:workspace',
        processIncarnation: `runtime_test:${handle}:1`,
        paneKey: handle === 'term_old' ? oldPane : newPane,
        launchTokenHash: null,
        hostScope: { kind: 'local', hostId: 'local' }
      }))
      const created = (await call('orchestration.runCreate', {
        objective: 'Recover exited owner',
        from: 'term_old'
      })) as { run: { id: string; consumer_generation: number } }
      vi.spyOn(runtime, 'inspectTerminalProcessIncarnationLiveness').mockResolvedValue('exited')

      const rebound = (await call('orchestration.runUse', {
        id: created.run.id,
        from: 'term_new'
      })) as { run: { coordinator_handle: string; consumer_generation: number } }

      expect(rebound.run).toMatchObject({
        coordinator_handle: 'term_new',
        consumer_generation: created.run.consumer_generation + 1
      })
    })

    it('binds an authority-less migrated Run without requiring a nonexistent incumbent', async () => {
      setup(false)
      const pane = 'tab_new:22222222-2222-4222-9222-222222222222'
      vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue(pane)
      vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation((handle) => ({
        runtimeId: 'runtime_test',
        terminalHandle: handle,
        ptyId: handle,
        worktreeId: 'folder:workspace',
        processIncarnation: `${handle}:incarnation-1`,
        paneKey: pane,
        launchTokenHash: null,
        hostScope: { kind: 'local', hostId: 'local' }
      }))
      const run = db.createRun({
        objective: 'Previously unbound',
        coordinatorHandle: 'term_old',
        coordinatorPaneKey: 'tab_old:11111111-1111-4111-8111-111111111111'
      })
      db.db
        .prepare(
          `UPDATE runs
           SET coordinator_handle = NULL, coordinator_pane_key = NULL,
               coordinator_process_incarnation = NULL, coordinator_host_scope = NULL
           WHERE id = ?`
        )
        .run(run.id)

      const rebound = (await call('orchestration.runUse', {
        id: run.id,
        from: 'term_new'
      })) as { run: { coordinator_handle: string } }

      expect(rebound.run.coordinator_handle).toBe('term_new')
    })

    it('cancels the Run bound during an asynchronous incumbent observation', async () => {
      setup(false)
      const oldPane = 'tab_old:11111111-1111-4111-8111-111111111111'
      const newPane = 'tab_new:22222222-2222-4222-9222-222222222222'
      vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
        handle === 'term_old' ? oldPane : newPane
      )
      vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation((handle) => ({
        runtimeId: 'runtime_test',
        terminalHandle: handle,
        ptyId: handle,
        worktreeId: 'folder:workspace',
        processIncarnation: `${handle}:incarnation-1`,
        paneKey: handle === 'term_old' ? oldPane : newPane,
        launchTokenHash: null,
        hostScope: { kind: 'local', hostId: 'local' }
      }))
      const target = (await call('orchestration.runCreate', {
        objective: 'Target Run',
        from: 'term_old'
      })) as { run: { id: string } }
      let finishObservation: ((status: 'exited') => void) | undefined
      vi.spyOn(runtime, 'inspectTerminalProcessIncarnationLiveness').mockImplementation(
        () => new Promise((resolve) => (finishObservation = resolve))
      )
      const cancel = vi.spyOn(runtime, 'cancelMessageWaiters')

      const use = call('orchestration.runUse', { id: target.run.id, from: 'term_new' })
      await vi.waitFor(() => expect(finishObservation).toBeTypeOf('function'))
      const overlapping = db.createRun({
        objective: 'Overlapping Run',
        coordinatorHandle: 'term_new',
        coordinatorPaneKey: newPane,
        coordinatorProcessIncarnation: 'term_new:incarnation-1',
        coordinatorHostScope: JSON.stringify({ kind: 'local', hostId: 'local' })
      })
      finishObservation?.('exited')
      await use

      expect(cancel).toHaveBeenCalledWith(`run:${overlapping.id}`)
    })

    it('rejects a claimant process that reincarnates during incumbent observation', async () => {
      setup(false)
      const oldPane = 'tab_old:11111111-1111-4111-8111-111111111111'
      const newPane = 'tab_new:22222222-2222-4222-9222-222222222222'
      let claimantIncarnation = 'term_new:incarnation-1'
      vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
        handle === 'term_old' ? oldPane : newPane
      )
      vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation((handle) => ({
        runtimeId: 'runtime_test',
        terminalHandle: handle,
        ptyId: handle,
        worktreeId: 'folder:workspace',
        processIncarnation: handle === 'term_old' ? 'term_old:incarnation-1' : claimantIncarnation,
        paneKey: handle === 'term_old' ? oldPane : newPane,
        launchTokenHash: null,
        hostScope: { kind: 'local', hostId: 'local' }
      }))
      const target = (await call('orchestration.runCreate', {
        objective: 'Keep claimant exact',
        from: 'term_old'
      })) as { run: { id: string } }
      let finishObservation: ((status: 'exited') => void) | undefined
      vi.spyOn(runtime, 'inspectTerminalProcessIncarnationLiveness').mockImplementation(
        () => new Promise((resolve) => (finishObservation = resolve))
      )

      const use = call('orchestration.runUse', { id: target.run.id, from: 'term_new' })
      await vi.waitFor(() => expect(finishObservation).toBeTypeOf('function'))
      claimantIncarnation = 'term_new:incarnation-2'
      finishObservation?.('exited')

      await expect(use).rejects.toMatchObject({
        code: 'consumer_fenced',
        data: {
          effectsApplied: false,
          coordinatorStatus: 'unverifiable',
          claimantStatus: 'changed',
          inspectCommandArgs: ['orchestration', 'run-show', '--id', target.run.id, '--json'],
          retryCommandArgs: ['orchestration', 'run-use', '--id', target.run.id, '--json'],
          nextSteps: expect.arrayContaining([
            expect.stringContaining('same Orca CLI executable'),
            expect.stringContaining('one stable replacement agent process')
          ])
        }
      })
      expect(db.getRun(target.run.id)).toMatchObject({
        coordinator_handle: 'term_old',
        consumer_generation: 1
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
      const otherPane = 'tab_other:33333333-3333-4333-8333-333333333333'
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
        coordinatorPaneKey: otherPane
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
        coordinatorPaneKey: newPane,
        incumbentObservation: {
          coordinatorHandle: 'term_old',
          coordinatorPaneKey: oldPane,
          coordinatorProcessIncarnation: null,
          coordinatorHostScope: null,
          status: 'exited'
        }
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
      vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation((handle) => ({
        runtimeId: 'runtime_test',
        terminalHandle: handle,
        ptyId: handle,
        worktreeId: 'folder:workspace',
        processIncarnation: `runtime_test:${handle}:1`,
        paneKey: handle === 'term_old' ? oldPane : newPane,
        launchTokenHash: null,
        hostScope: { kind: 'local', hostId: 'local' }
      }))
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
      vi.spyOn(runtime, 'inspectTerminalProcessIncarnationLiveness').mockResolvedValue('exited')

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
