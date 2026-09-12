import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { createMockSubprocess, startDaemonAdapterHarness } from './daemon-pty-adapter-test-harness'
import type { DaemonRequestRouter } from './daemon-request-router'
import type { DaemonPtySpawnPreparations } from './daemon-pty-spawn-preparations'
import type { DaemonRequest } from './types'
import { MAX_EXIT_RECEIPTS, type TerminalHostSessionRecord } from './terminal-host-session-record'
import { localProvider, setLocalPtyProvider } from '../ipc/pty/provider/registry'
import {
  inspectExitedIncarnationFromRuntimeController,
  releaseExitedIncarnationFromRuntimeController
} from '../ipc/pty/runtime/operations'

describe('exit receipt consumption is bookkeeping, not terminal shutdown', () => {
  let harness: Awaited<ReturnType<typeof startDaemonAdapterHarness>>
  let subprocess: ReturnType<typeof createMockSubprocess>
  let previousProvider: typeof localProvider

  beforeEach(async () => {
    previousProvider = localProvider
    harness = await startDaemonAdapterHarness(() => {
      subprocess = createMockSubprocess()
      return subprocess
    })
    setLocalPtyProvider(harness.adapter)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    setLocalPtyProvider(previousProvider)
    harness?.adapter.dispose()
    await harness?.server.shutdown()
    if (harness) {
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })

  function router(): DaemonRequestRouter {
    return (harness.server as unknown as { requestRouter: DaemonRequestRouter }).requestRouter
  }

  async function exited(id: string) {
    const spawned = await harness.adapter.spawn({ sessionId: id, cols: 80, rows: 24 })
    const incarnation = spawned.incarnationId!
    subprocess._simulateExit(0)
    expect(await inspectExitedIncarnationFromRuntimeController(id, incarnation)).toBe(true)
    return incarnation
  }

  it.each(['current', 'legacy without kill fence'] as const)(
    'preserves a replacement process on a %s daemon',
    async (version) => {
      const id = 'receipt-replaced'
      const oldIncarnation = await exited(id)
      const replacement = await harness.adapter.spawn({ sessionId: id, cols: 80, rows: 24 })
      const child = subprocess
      expect(replacement.incarnationId).not.toBe(oldIncarnation)
      if (version === 'legacy without kill fence') {
        const originalRoute = router().route.bind(router())
        vi.spyOn(router(), 'route').mockImplementation((clientId, request) => {
          if (request.type === 'consumeExitReceipt') {
            throw new Error('Unknown request type: consumeExitReceipt')
          }
          // v1.4.199 reads sessionId/immediate but ignores the new kill condition.
          const compatible: DaemonRequest =
            request.type === 'kill'
              ? {
                  ...request,
                  payload: {
                    sessionId: request.payload.sessionId,
                    immediate: request.payload.immediate
                  }
                }
              : request
          return originalRoute(clientId, compatible)
        })
      }

      await releaseExitedIncarnationFromRuntimeController(id, oldIncarnation)

      expect(child.forceKill).not.toHaveBeenCalled()
      expect(child.kill).not.toHaveBeenCalled()
      expect(await harness.adapter.probePtyLiveness(id)).toBe(true)
    }
  )

  it('leaves another client’s replacement spawn preparation untouched', async () => {
    const id = 'receipt-preparing'
    const incarnation = await exited(id)
    const preparations = (
      router() as unknown as {
        options: { preparations: DaemonPtySpawnPreparations }
      }
    ).options.preparations
    // Register at the real admission boundary before native spawn has completed.
    const preparation = preparations.register(id, 'replacement-client', 'spawn-request', undefined)
    try {
      await releaseExitedIncarnationFromRuntimeController(id, incarnation)
      expect(preparation.canceled).toBe(false)
      expect(preparation.controller.signal.aborted).toBe(false)
      await expect(preparations.prepareUnlessCanceled(id, preparation)).resolves.toBeUndefined()
    } finally {
      preparations.finish(id, preparation)
    }
  })

  it('cannot stop even a live process with the matching incarnation', async () => {
    const id = 'receipt-still-live'
    const spawned = await harness.adapter.spawn({ sessionId: id, cols: 80, rows: 24 })
    const child = subprocess
    await releaseExitedIncarnationFromRuntimeController(id, spawned.incarnationId!)
    expect(child.kill).not.toHaveBeenCalled()
    expect(child.forceKill).not.toHaveBeenCalled()
    expect(await harness.adapter.probePtyLiveness(id)).toBe(true)
  })

  it('returns no exit proof after eviction and safely accepts late acknowledgement', async () => {
    await harness.adapter.spawn({ sessionId: 'live-sentinel', cols: 80, rows: 24 })
    const host = (
      harness.server as unknown as {
        host: { sessions: Map<string, TerminalHostSessionRecord> }
      }
    ).host
    for (let i = 0; i < MAX_EXIT_RECEIPTS; i++) {
      host.sessions.set(`old-${i}`, { incarnationId: `old-inc-${i}`, code: 0 })
    }
    expect(await inspectExitedIncarnationFromRuntimeController('old-0', 'old-inc-0')).toBe(true)
    const fresh = await exited('fresh-exit')
    expect(await inspectExitedIncarnationFromRuntimeController('old-0', 'old-inc-0')).toBe(false)
    expect(await inspectExitedIncarnationFromRuntimeController('old-1', 'old-inc-1')).toBe(true)
    expect(await inspectExitedIncarnationFromRuntimeController('fresh-exit', fresh)).toBe(true)
    expect(await harness.adapter.probePtyLiveness('live-sentinel')).toBe(true)
    await expect(harness.adapter.consumeExitReceipt('old-0', 'old-inc-0')).resolves.toBeUndefined()
  })

  it('consumes only matching receipts and tolerates duplicate or missing acknowledgements', async () => {
    const id = 'receipt-repeat'
    const incarnation = await exited(id)
    await harness.adapter.consumeExitReceipt(id, 'different-incarnation')
    expect(await inspectExitedIncarnationFromRuntimeController(id, incarnation)).toBe(true)
    await harness.adapter.consumeExitReceipt(id, incarnation)
    expect(await inspectExitedIncarnationFromRuntimeController(id, incarnation)).toBe(false)
    await expect(harness.adapter.consumeExitReceipt(id, incarnation)).resolves.toBeUndefined()
    await expect(harness.adapter.consumeExitReceipt('absent', incarnation)).resolves.toBeUndefined()
  })

  it('leaves evidence intact when an old host rejects consumption', async () => {
    const id = 'receipt-unsupported'
    const incarnation = await exited(id)
    const originalRoute = router().route.bind(router())
    const calls = vi.spyOn(router(), 'route').mockImplementation((clientId, request) => {
      if (request.type === 'consumeExitReceipt') {
        throw new Error('Unknown request type: consumeExitReceipt')
      }
      return originalRoute(clientId, request)
    })
    await expect(
      releaseExitedIncarnationFromRuntimeController(id, incarnation)
    ).resolves.toBeUndefined()
    expect(await inspectExitedIncarnationFromRuntimeController(id, incarnation)).toBe(true)
    expect(calls.mock.calls.some(([, request]) => request.type === 'kill')).toBe(false)
  })

  it('preserves history and does not mark an observed exit as an explicit kill', async () => {
    const id = 'receipt-history'
    const incarnation = await exited(id)
    const state = harness.adapter as unknown as {
      historyManager: unknown
      killedSessionTombstones: Map<string, number>
    }
    const originalHistory = state.historyManager
    const removeSession = vi.fn(async () => {})
    state.historyManager = { removeSession, closeSession: vi.fn(async () => {}) }
    try {
      await releaseExitedIncarnationFromRuntimeController(id, incarnation)
      expect(removeSession).not.toHaveBeenCalled()
      expect(state.killedSessionTombstones.has(id)).toBe(false)
      expect(await inspectExitedIncarnationFromRuntimeController(id, incarnation)).toBe(false)
    } finally {
      state.historyManager = originalHistory
    }
  })
})
