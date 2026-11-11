import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createIdleSyncHarness } from './synchronization/federation-sync-test-harness'
import { RuntimeOrchestrationFederation } from './runtime-orchestration-federation'
import type { OrchestrationEnvironmentTransport } from './environment-transport'

describe('RuntimeOrchestrationFederation relay', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('stops relaying to a removed server and delivers its pending mail after the next ensureRelay', async () => {
    const { runtime, remoteCall } = createIdleSyncHarness()
    const db = runtime.getOrchestrationDb()
    const active = db.getFederatedDispatch('dispatch_remote')
    db.listActiveFederatedDispatches = () => (active ? [active] : [])
    let serverSaved = false
    let noteRefused!: () => void
    const refused = new Promise<void>((resolve) => (noteRefused = resolve))
    let noteAcknowledged!: () => void
    const acknowledgedOnce = new Promise<void>((resolve) => (noteAcknowledged = resolve))
    const recordAcknowledgment = db.recordFederatedHomeAcknowledgment.bind(db)
    db.recordFederatedHomeAcknowledgment = (params) => {
      recordAcknowledgment(params)
      noteAcknowledged()
    }
    const answer = remoteCall.getMockImplementation()!
    remoteCall.mockImplementation(async (...args) => {
      if (!serverSaved) {
        noteRefused()
        throw new Error('Unknown environment: environment_windows')
      }
      return answer(...args)
    })
    const transport: OrchestrationEnvironmentTransport = {
      resolve: () => {
        throw new Error('unused')
      },
      call: () => {
        throw new Error('unused')
      },
      hasEnvironment: () => serverSaved
    }
    const federation = new RuntimeOrchestrationFederation(runtime, transport)
    const acknowledged = () =>
      runtime.getOrchestrationDb().getFederatedDispatch('dispatch_remote')
        ?.to_home_acknowledged_sequence

    federation.ensureRelay()
    await refused
    await vi.advanceTimersByTimeAsync(0)
    serverSaved = true
    // A relay that ended leaves no timer behind; one still backing off would retry and deliver here.
    await vi.runAllTimersAsync()
    expect(acknowledged()).toBe(0)

    federation.ensureRelay()

    await acknowledgedOnce
    expect(acknowledged()).toBeGreaterThan(0)
    federation.stopRelay()
  })
})
