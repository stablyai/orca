import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'

describe('terminal federation acknowledgment recovery', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('bounds migration replay to one oldest-first recovery', async () => {
    vi.useFakeTimers()
    const candidates = Array.from({ length: 1_000 }, (_, index) => ({
      dispatchId: `dispatch_${index + 1}`,
      rowId: index + 1
    }))
    const runtime = new OrcaRuntimeService(null, undefined, {
      orchestrationEnvironmentTransport: {
        resolve: vi.fn(),
        call: vi.fn()
      }
    })
    const sync = vi
      .spyOn(runtime, 'syncOrchestrationFederatedDispatch')
      .mockResolvedValue(undefined)
    runtime.setOrchestrationDb({
      listActiveFederatedDispatches: () => [],
      findNextTerminalFederatedDispatchPendingAcknowledgment: (afterRowId: number) =>
        candidates.find((candidate) => candidate.rowId > afterRowId)
    } as never)

    await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(1))
    expect(sync.mock.calls).toEqual([['dispatch_1']])

    await vi.advanceTimersByTimeAsync(3_000)

    expect(sync.mock.calls).toEqual([
      ['dispatch_1'],
      ['dispatch_2'],
      ['dispatch_3'],
      ['dispatch_4']
    ])
    runtime.stopOrchestrationFederationRelay()
  })

  it('gives every unavailable terminal dispatch a turn before retrying', async () => {
    vi.useFakeTimers()
    const candidates = [1, 2, 3].map((rowId) => ({
      dispatchId: `dispatch_${rowId}`,
      rowId
    }))
    const runtime = new OrcaRuntimeService(null, undefined, {
      orchestrationEnvironmentTransport: {
        resolve: vi.fn(),
        call: vi.fn()
      }
    })
    const sync = vi
      .spyOn(runtime, 'syncOrchestrationFederatedDispatch')
      .mockRejectedValue(new Error('worker unavailable'))
    runtime.setOrchestrationDb({
      listActiveFederatedDispatches: () => [],
      findNextTerminalFederatedDispatchPendingAcknowledgment: (afterRowId: number) =>
        candidates.find((candidate) => candidate.rowId > afterRowId)
    } as never)

    await vi.advanceTimersByTimeAsync(3_000)

    expect(sync.mock.calls).toEqual([
      ['dispatch_1'],
      ['dispatch_2'],
      ['dispatch_3'],
      ['dispatch_1']
    ])
    runtime.stopOrchestrationFederationRelay()
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
    runtime.setOrchestrationDb({
      listActiveFederatedDispatches: () => [],
      findNextTerminalFederatedDispatchPendingAcknowledgment: () => ({
        dispatchId: 'dispatch_1',
        rowId: 1
      })
    } as never)
    expect(sync).toHaveBeenCalledTimes(1)

    runtime.stopOrchestrationFederationRelay()
    release()
    await vi.advanceTimersByTimeAsync(5_000)

    expect(sync).toHaveBeenCalledTimes(1)
  })
})
