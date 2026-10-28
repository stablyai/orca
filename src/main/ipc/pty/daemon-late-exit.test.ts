import { describe, expect, it } from 'vitest'
import { startLateExitHarness } from './daemon-late-exit-test-fixture'

const FINAL_OUTPUT = 'delayed final output\r\n'

describe('daemon physical exit after synthetic renderer exit', () => {
  it('retires delayed output after the kill control reply overtakes the stream', async () => {
    const harness = await startLateExitHarness()
    try {
      harness.pauseStream()
      harness.subprocess._simulateData(FINAL_OUTPUT)
      await harness.kill()
      expect(harness.runtime.captureState().connected).toBe(false)
      expect(harness.providerExits).toHaveLength(0)
      expect(await harness.adapter.listProcesses()).toEqual([])
      harness.resumeStream()
      await harness.waitForExit()
      expect(await harness.capture()).toMatchObject({
        connected: false,
        headlessModelRetained: false,
        titleTrackerRetained: false,
        providerHasPty: false,
        hostInventoryCount: 0,
        deliveredData: [FINAL_OUTPUT],
        rendererExitCount: 1,
        providerExitCount: 1,
        exitListenerCalls: 1,
        exitCause: { kind: 'operator_close' }
      })
    } finally {
      await harness.dispose()
    }
  })

  it('does not revive a process already proven exited by fresh host inventory', async () => {
    const harness = await startLateExitHarness()
    try {
      harness.pauseStream()
      harness.subprocess._simulateData(FINAL_OUTPUT)
      expect(await harness.stopAndWait()).toBe(true)
      expect(harness.runtime.captureState()).toMatchObject({ connected: false, liveness: 'exited' })
      harness.resumeStream()
      await harness.waitForExit()
      expect(await harness.capture()).toMatchObject({
        connected: false,
        liveness: 'exited',
        headlessModelRetained: false,
        deliveredData: [FINAL_OUTPUT],
        rendererExitCount: 1,
        exitListenerCalls: 1,
        exitCause: { kind: 'operator_close' }
      })
    } finally {
      await harness.dispose()
    }
  })

  it('reconciles physical exit without another renderer notification when no data was queued', async () => {
    const harness = await startLateExitHarness()
    try {
      harness.pauseStream()
      await harness.kill()
      harness.resumeStream()
      await harness.waitForExit()
      expect(await harness.capture()).toMatchObject({
        connected: false,
        headlessModelRetained: false,
        deliveredData: [],
        rendererExitCount: 1,
        providerExitCount: 1,
        exitListenerCalls: 1
      })
    } finally {
      await harness.dispose()
    }
  })

  it('preserves ordinary stream-ordered output and natural exit', async () => {
    const harness = await startLateExitHarness()
    try {
      harness.subprocess._simulateData(FINAL_OUTPUT)
      harness.subprocess._simulateExit(0)
      await harness.waitForExit()
      expect(await harness.capture()).toMatchObject({
        connected: false,
        headlessModelRetained: false,
        deliveredData: [FINAL_OUTPUT],
        rendererExitCount: 1,
        providerExitCount: 1,
        exitListenerCalls: 1,
        exitCause: { kind: 'exited', exitCode: 0 }
      })
    } finally {
      await harness.dispose()
    }
  })

  it('does not suppress the replacement incarnation exit with its predecessor marker', async () => {
    const harness = await startLateExitHarness()
    try {
      harness.pauseStream()
      await harness.kill()
      const replacement = await harness.respawn()
      expect(replacement.id).toBe(harness.id)
      expect(replacement.incarnationId).not.toBe(harness.result.incarnationId)
      harness.subprocess._simulateData(FINAL_OUTPUT)
      harness.subprocess._simulateExit(0)
      harness.resumeStream()
      await harness.waitForExit()
      expect(await harness.capture()).toMatchObject({
        incarnationId: replacement.incarnationId,
        connected: false,
        headlessModelRetained: false,
        deliveredData: [FINAL_OUTPUT],
        rendererExitCount: 2,
        providerExitCount: 1,
        exitListenerCalls: 2,
        exitCause: { kind: 'exited', exitCode: 0 }
      })
    } finally {
      await harness.dispose()
    }
  })

  it('keeps a new synthetic marker when the old incarnation exit arrives first', async () => {
    const harness = await startLateExitHarness()
    try {
      harness.pauseStream()
      await harness.kill()
      const replacement = await harness.respawn()
      harness.subprocess._simulateData(FINAL_OUTPUT)
      await harness.kill()
      expect(harness.session.syntheticKillExitPtyIds.get(harness.id)?.incarnationId).toBe(
        replacement.incarnationId
      )
      harness.resumeStream()
      await harness.waitForExit()
      expect(await harness.capture()).toMatchObject({
        incarnationId: replacement.incarnationId,
        connected: false,
        headlessModelRetained: false,
        deliveredData: [FINAL_OUTPUT],
        rendererExitCount: 2,
        providerExitCount: 1,
        exitListenerCalls: 2,
        exitCause: { kind: 'operator_close' }
      })
      expect(harness.session.syntheticKillExitPtyIds.has(harness.id)).toBe(false)
    } finally {
      await harness.dispose()
    }
  })

  it('rejects a stale provider exit before touching replacement state or its marker', async () => {
    const harness = await startLateExitHarness()
    try {
      harness.pauseStream()
      await harness.kill()
      const replacement = await harness.respawn()
      harness.session.rememberSyntheticKillExit(harness.id, replacement.incarnationId)
      const marker = harness.session.syntheticKillExitPtyIds.get(harness.id)
      harness.deliverProviderExit({
        id: harness.id,
        code: 137,
        incarnationId: harness.result.incarnationId
      })
      expect(harness.session.syntheticKillExitPtyIds.get(harness.id)).toBe(marker)
      expect(harness.runtime.captureState()).toMatchObject({
        connected: true,
        incarnationId: replacement.incarnationId
      })
      expect(harness.rendererExits).toHaveLength(1)
    } finally {
      await harness.dispose()
    }
  })

  it('matches legacy exits only to legacy synthetic markers', async () => {
    const harness = await startLateExitHarness()
    try {
      const session = harness.session
      session.rememberSyntheticKillExit(harness.id)
      expect(session.consumeSyntheticKillExit(harness.id, 'new-incarnation')).toBe(false)
      expect(session.syntheticKillExitPtyIds.has(harness.id)).toBe(true)
      expect(session.consumeSyntheticKillExit(harness.id)).toBe(true)
      session.rememberSyntheticKillExit(harness.id, 'new-incarnation')
      expect(session.consumeSyntheticKillExit(harness.id)).toBe(false)
      expect(session.consumeSyntheticKillExit(harness.id, 'new-incarnation')).toBe(true)
      expect(session.consumeSyntheticKillExit(harness.id, 'new-incarnation')).toBe(false)
    } finally {
      await harness.dispose()
    }
  })
})

describe('synthetic exit and orchestration settlement', () => {
  it('settles an active dispatch and its exit listener only once', async () => {
    const { OrchestrationDb } = await import('../../runtime/orchestration/db')
    const { createRootDispatch } =
      await import('../../runtime/orchestration/db/root-dispatch-test-fixture')
    const { vi } = await import('vitest')
    const harness = await startLateExitHarness()
    const db = new OrchestrationDb(':memory:')
    try {
      harness.runtime.setOrchestrationDb(db)
      const handle = 'term_late_exit'
      harness.runtime.registerPreAllocatedHandleForPty(harness.id, handle)
      const run = db.createRun({
        objective: 'Late exit reconciliation',
        coordinatorHandle: 'term_coordinator',
        coordinatorPaneKey:
          '99999999-9999-4999-8999-999999999999:88888888-8888-4888-8888-888888888888'
      })
      const task = db.createTask({ spec: 'Test physical exit reconciliation', runId: run.id })
      createRootDispatch(db, task.id, handle)
      const failDispatch = vi.spyOn(db, 'failDispatch')
      const insertMessage = vi.spyOn(db, 'insertMessage')
      harness.pauseStream()
      harness.subprocess._simulateData(FINAL_OUTPUT)
      await harness.kill()
      const settledAfterSynthetic = failDispatch.mock.calls.length
      const messagesAfterSynthetic = insertMessage.mock.calls.length
      expect(settledAfterSynthetic).toBe(1)
      harness.resumeStream()
      await harness.waitForExit()
      expect(failDispatch).toHaveBeenCalledTimes(settledAfterSynthetic)
      expect(insertMessage).toHaveBeenCalledTimes(messagesAfterSynthetic)
      expect((await harness.capture()).exitListenerCalls).toBe(1)
      expect(harness.runtime.captureState().exitCause).toEqual({ kind: 'operator_close' })
    } finally {
      await harness.dispose()
      db.close()
    }
  })
})
