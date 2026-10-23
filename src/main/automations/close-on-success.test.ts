import { describe, expect, it, vi } from 'vitest'
import {
  closeTestStores,
  createStore,
  makeRepo,
  readDataFile,
  writeDataFile
} from '../persistence-test-harness'
import type { AutomationRunStatus } from '../../shared/automations-types'
import { AutomationCreate, AutomationUpdate } from '../../shared/rpc-contract/automation-params'
import { RuntimeAutomationController } from '../runtime/runtime-automation-controller'
import { createRuntimeAutomationService } from './runtime-automation-service'
import { BASE, setup, snapshot } from './close-on-success.test-fixture'

describe('automation close on success', () => {
  it('defaults new and legacy definitions and runs to false, without retroactive opt-in', async () => {
    const { store } = await setup()
    const automation = store.createAutomation(BASE)
    const run = store.createAutomationRun(automation, 1)
    expect(automation.closeOnSuccess).toBe(false)
    expect(run.closeOnSuccess).toBe(false)
    const state = JSON.parse(JSON.stringify(readDataFile()))
    delete state.automations[0].closeOnSuccess
    delete state.automationRuns[0].closeOnSuccess
    await closeTestStores()
    writeDataFile(state)
    const reloaded = await createStore()
    expect(reloaded.listAutomations()[0].closeOnSuccess).toBe(false)
    expect(reloaded.listAutomationRuns()[0].closeOnSuccess).toBe(false)
    reloaded.updateAutomation(automation.id, { closeOnSuccess: true })
    expect(reloaded.listAutomationRuns()[0].closeOnSuccess).toBe(false)
    await reloaded.flushPendingOrThrowAsync()
    expect(readDataFile()).toMatchObject({
      automations: [{ closeOnSuccess: true }],
      automationRuns: [{ closeOnSuccess: false }]
    })
  })

  it('preserves omitted updates, snapshots policy, and roundtrips definitions and runs', async () => {
    const { store } = await setup()
    const automation = store.createAutomation({ ...BASE, closeOnSuccess: true })
    const run = store.createAutomationRun(automation, 1)
    expect(store.updateAutomation(automation.id, { prompt: 'Edited' }).closeOnSuccess).toBe(true)
    expect(
      store.updateAutomation(automation.id, { closeOnSuccess: undefined }).closeOnSuccess
    ).toBe(true)
    store.updateAutomation(automation.id, { closeOnSuccess: false })
    expect(store.listAutomationRuns()[0].closeOnSuccess).toBe(true)
    await closeTestStores()
    const reloaded = await createStore()
    expect(reloaded.listAutomations()[0].closeOnSuccess).toBe(false)
    expect(reloaded.listAutomationRuns()[0]).toMatchObject({ id: run.id, closeOnSuccess: true })
  })

  it('rejects effective reuse conflicts on create and either update field atomically', async () => {
    const { store } = await setup()
    expect(() =>
      store.createAutomation({ ...BASE, reuseSession: true, closeOnSuccess: true })
    ).toThrow('fresh session')
    const reused = store.createAutomation({ ...BASE, reuseSession: true })
    expect(() => store.updateAutomation(reused.id, { closeOnSuccess: true })).toThrow(
      'fresh session'
    )
    const closing = store.createAutomation({ ...BASE, closeOnSuccess: true })
    expect(() => store.updateAutomation(closing.id, { reuseSession: true })).toThrow(
      'fresh session'
    )
    expect(store.listAutomations().find((entry) => entry.id === closing.id)?.reuseSession).toBe(
      false
    )
    expect(
      store.updateAutomation(reused.id, { reuseSession: false, closeOnSuccess: true })
        .closeOnSuccess
    ).toBe(true)
  })

  it('routes create and partial updates through the runtime controller without dropping policy', async () => {
    const h = await setup()
    const controller = new RuntimeAutomationController(h.store, {
      showRepo: async () => makeRepo(),
      showManagedWorktree: async () => ({ id: 'wt1', repoId: 'r1', path: '/repo' })
    })
    const automation = await controller.create({
      ...BASE,
      workspace: 'id:wt1',
      closeOnSuccess: true
    })
    expect(automation.closeOnSuccess).toBe(true)
    expect((await controller.update(automation.id, { prompt: 'Edited' })).closeOnSuccess).toBe(true)
    await expect(controller.update(automation.id, { reuseSession: true })).rejects.toThrow(
      'fresh session'
    )
    expect((await controller.update(automation.id, { closeOnSuccess: false })).closeOnSuccess).toBe(
      false
    )
    await controller.update(automation.id, { reuseSession: true })
    await expect(controller.update(automation.id, { closeOnSuccess: true })).rejects.toThrow(
      'fresh session'
    )
  })

  it('carries optional booleans over RPC and rejects invalid values', () => {
    expect(AutomationCreate.parse({ ...BASE, closeOnSuccess: true }).closeOnSuccess).toBe(true)
    expect(
      AutomationUpdate.parse({ id: 'a', updates: { closeOnSuccess: false } }).updates.closeOnSuccess
    ).toBe(false)
    expect(AutomationUpdate.parse({ id: 'a', updates: {} }).updates.closeOnSuccess).toBeUndefined()
    expect(
      AutomationUpdate.safeParse({ id: 'a', updates: { closeOnSuccess: 'true' } }).success
    ).toBe(false)
  })

  it.each([true, false])(
    'closes only the owner pane after snapshot and usage save (headless=%s)',
    async (headless) => {
      const h = await setup(headless)
      const { automation, run } = h.launch()
      const finished = await h.service.markDispatchResult({
        runId: run.id,
        status: 'completed',
        outputSnapshot: snapshot
      })
      await h.settle(automation.id)
      expect(finished.status).toBe('completed')
      expect(h.runtime.closeTerminal.mock.calls).toEqual([
        ['run:11111111-1111-4111-8111-111111111111']
      ])
      expect(h.panes.get('run:22222222-2222-4222-8222-222222222222')).toBe('pty-user')
      expect(h.runtime.sleepTerminalsForWorktree).not.toHaveBeenCalled()
      expect(h.store.listAutomationRuns()[0]).toMatchObject({
        status: 'completed',
        terminalPaneKey: null,
        outputSnapshot: snapshot
      })
      await h.service.reconcileFinishedRunTerminals?.()
      expect(h.runtime.closeTerminal).toHaveBeenCalledTimes(1)
    }
  )

  it('waits for provider usage collection and its durable write before closing', async () => {
    let releaseUsage = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseUsage = resolve
    })
    const h = await setup(true, gate)
    const { automation, run } = h.launch(true, 'manual', 'claude')
    const finishing = h.service.markDispatchResult({
      runId: run.id,
      status: 'completed',
      outputSnapshot: snapshot
    })
    await h.usageRequested
    expect(readDataFile()).toMatchObject({
      automationRuns: [{ status: 'completed', outputSnapshot: snapshot, usage: null }]
    })
    await h.service.reconcileFinishedRunTerminals?.()
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
    releaseUsage()
    await finishing
    await h.settle(automation.id)
    expect(h.runtime.closeTerminal).toHaveBeenCalledTimes(1)
  })

  it.each(['used', 'unknown'] as const)(
    'protects a %s terminal even for an opted-in run',
    async (use) => {
      const h = await setup()
      const { automation, run } = h.launch()
      h.runtime.readTerminalClientUse.mockReturnValue(use)
      await h.service.markDispatchResult({
        runId: run.id,
        status: 'completed',
        outputSnapshot: snapshot
      })
      await h.settle(automation.id)
      expect(h.panes.get('run:11111111-1111-4111-8111-111111111111')).toBe('pty-run')
      expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
    }
  )

  it.each(['dispatch_failed', 'skipped_precheck', 'dispatched'] as const)(
    'keeps opted-in %s runs across sweeps',
    async (status: AutomationRunStatus) => {
      const h = await setup()
      const { run } = h.launch()
      await h.service.markDispatchResult({ runId: run.id, status, outputSnapshot: snapshot })
      await h.service.reconcileFinishedRunTerminals?.()
      await vi.advanceTimersByTimeAsync(60 * 60_000)
      await h.service.reconcileFinishedRunTerminals?.()
      expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
    }
  )

  it('preserves defaults and requires a saved snapshot before opt-in cleanup', async () => {
    const h = await setup()
    const { automation, run } = h.launch(false)
    await h.service.markDispatchResult({
      runId: run.id,
      status: 'completed',
      outputSnapshot: snapshot
    })
    await h.settle(automation.id)
    h.store.updateAutomation(automation.id, { closeOnSuccess: true })
    await h.service.reconcileFinishedRunTerminals?.()
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
    const next = h.store.createAutomationRun(h.store.listAutomations()[0], Date.now() + 1)
    h.store.updateAutomationRun({
      runId: next.id,
      status: 'dispatched',
      terminalPaneKey: 'run:11111111-1111-4111-8111-111111111111',
      terminalPtyId: 'pty-run'
    })
    await h.service.markDispatchResult({ runId: next.id, status: 'completed' })
    await h.settle(automation.id)
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it('leaves replaced PTYs and unrelated panes untouched', async () => {
    const h = await setup()
    const { automation, run } = h.launch()
    h.panes.set('run:11111111-1111-4111-8111-111111111111', 'pty-replaced')
    await h.service.markDispatchResult({
      runId: run.id,
      status: 'completed',
      outputSnapshot: snapshot
    })
    await h.settle(automation.id)
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
    expect([...h.panes.values()]).toEqual(['pty-replaced', 'pty-user'])
  })

  it.each([
    { turnEndDisposition: undefined },
    { turnEndDisposition: 'ambiguous' as const },
    { turnEndedAt: undefined },
    { turnEndedAt: 0 },
    { stateStartedAt: 0 },
    { sessionBoundary: true },
    { providerSessionOnly: true },
    { interrupted: true },
    { restoredUnconfirmed: true }
  ])('retains completion evidence that is not a current identified turn end: %j', async (patch) => {
    const h = await setup()
    const { automation, run } = h.launch()
    const row = h.runtime.getAgentStatusRowsForPane()[0]
    h.runtime.getAgentStatusRowsForPane.mockReturnValue([{ ...row, ...patch }])
    await h.service.markDispatchResult({
      runId: run.id,
      status: 'completed',
      outputSnapshot: snapshot
    })
    await h.settle(automation.id)
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it('keeps hookless idle completions until the shell alone is positively confirmed', async () => {
    const h = await setup()
    const { automation, run } = h.launch()
    h.runtime.getAgentStatusRowsForPane.mockReturnValue([])
    await h.service.markDispatchResult({
      runId: run.id,
      status: 'completed',
      outputSnapshot: snapshot
    })
    await h.settle(automation.id)
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
    h.runtime.confirmTerminalShellAlone.mockResolvedValue(true)
    await h.service.reconcileFinishedRunTerminals?.()
    expect(h.runtime.closeTerminal).toHaveBeenCalledTimes(1)
  })

  it.each(['output', 'usage'] as const)(
    'cannot close while a %s flush is pending or rejected',
    async (phase) => {
      const h = await setup()
      const { automation, run } = h.launch()
      await h.store.flushPendingOrThrowAsync()
      const flush = h.store.flushPendingOrThrowAsync.bind(h.store)
      let rejectFlush = (_error: Error) => {}
      let blocked = false
      const gate = new Promise<void>((_resolve, reject) => {
        rejectFlush = reject
      })
      let writeReached = () => {}
      const reached = new Promise<void>((resolve) => {
        writeReached = resolve
      })
      const spy = vi
        .spyOn(h.store, 'flushPendingOrThrowAsync')
        .mockImplementation(async (options) => {
          const current = h.store.listAutomationRuns()[0]
          if (current.status === 'completed' && (phase === 'output' || current.usage !== null)) {
            blocked = true
            writeReached()
          }
          if (blocked) {
            await gate
          }
          return flush(options)
        })
      const finishing = h.service.markDispatchResult({
        runId: run.id,
        status: 'completed',
        outputSnapshot: snapshot
      })
      const result = finishing.catch((error: unknown) => error)
      await reached
      const sweep = h.service.reconcileFinishedRunTerminals?.()
      await Promise.resolve()
      expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
      rejectFlush(new Error('flush rejected'))
      await sweep
      expect(await result).toEqual(new Error('flush rejected'))
      expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
      spy.mockRestore()
      await h.service.markDispatchResult({ runId: run.id, status: 'completed' })
      await h.settle(automation.id)
      expect(h.runtime.closeTerminal).toHaveBeenCalledTimes(1)
    }
  )

  it('keeps successful status after cleanup failure and retries idempotently on reconciliation', async () => {
    const h = await setup()
    const { automation, run } = h.launch()
    h.runtime.closeTerminal.mockRejectedValueOnce(new Error('close failed'))
    await h.service.markDispatchResult({
      runId: run.id,
      status: 'completed',
      outputSnapshot: snapshot
    })
    await h.settle(automation.id)
    expect(h.store.listAutomationRuns()[0]).toMatchObject({
      status: 'completed',
      terminalPtyId: 'pty-run'
    })
    await h.service.reconcileFinishedRunTerminals?.()
    await h.service.reconcileFinishedRunTerminals?.()
    expect(h.runtime.closeTerminal).toHaveBeenCalledTimes(2)
    expect(h.store.listAutomationRuns()[0]).toMatchObject({
      status: 'completed',
      terminalPtyId: null
    })
  })

  it.each(['scheduled', 'manual'] as const)(
    'recovers a %s completion interrupted before usage collection at startup',
    async (trigger) => {
      const h = await setup(false)
      const { automation, run } = h.launch(true, trigger)
      h.store.updateAutomationRun({ runId: run.id, status: 'completed', outputSnapshot: snapshot })
      await closeTestStores()
      const recoveredStore = await createStore()
      const recovered = createRuntimeAutomationService({
        store: recoveredStore,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the same runtime ports model PTYs adopted after restart.
        runtime: h.runtime as never,
        headless: false
      })
      recovered.start()
      try {
        await vi.advanceTimersByTimeAsync(0)
        await recovered.runInAutomationLane(automation.id, async () => {})
        expect(h.runtime.closeTerminal).toHaveBeenCalledTimes(1)
        expect(recoveredStore.listAutomationRuns()[0]).toMatchObject({
          status: 'completed',
          terminalPtyId: null,
          usage: expect.objectContaining({ status: 'unavailable' })
        })
      } finally {
        recovered.stop()
      }
    }
  )
})
