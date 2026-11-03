import { createFederationSyncDatabase } from './federation-sync-test-harness'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'

describe('terminal federation acknowledgment recovery', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not restart recovery after relay shutdown', async () => {
    vi.useFakeTimers()
    let release!: () => void
    const blocked = new Promise<void>((resolve) => (release = resolve))
    const runtime = new OrcaRuntimeService(null, undefined, {
      orchestrationEnvironmentTransport: {
        resolve: vi.fn(),
        call: vi.fn()
      }
    })
    const sync = vi.spyOn(runtime, 'syncOrchestrationFederatedDispatch').mockReturnValue(blocked)
    const { db } = createFederationSyncDatabase()
    db.findNextTerminalFederatedDispatchPendingAcknowledgment = () => ({
      dispatchId: 'dispatch_1',
      rowId: 1
    })
    runtime.setOrchestrationDb(db)
    expect(sync).toHaveBeenCalledTimes(1)

    runtime.stopOrchestrationFederationRelay()
    release()
    await vi.advanceTimersByTimeAsync(5_000)

    expect(sync).toHaveBeenCalledTimes(1)
  })
})
