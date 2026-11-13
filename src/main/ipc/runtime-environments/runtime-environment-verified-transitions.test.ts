import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeHostStatusSnapshot } from '../../../shared/remote-runtime/host-status/runtime-host-status'
import { trackRuntimeEnvironmentVerifiedTransitions } from './runtime-environment-verified-transitions'
import { FederationRelayScheduler } from '../../runtime/orchestration/federation/relay/federation-relay-scheduler'

let sequence = 0
function snapshot(
  environmentId: string,
  verification: RuntimeHostStatusSnapshot['verification']
): RuntimeHostStatusSnapshot {
  sequence += 1
  return {
    environmentId,
    pairingRevision: 1,
    sequence,
    checkedAt: sequence,
    status: null,
    verification,
    transport: 'ready'
  }
}

describe('trackRuntimeEnvironmentVerifiedTransitions', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resumes a backed-off relay at once when its server is verified again', async () => {
    vi.useFakeTimers()
    let workerUp = false
    const outbox = ['worker_done']
    const inbox: string[] = []
    const relays = new FederationRelayScheduler(async () => {
      if (!workerUp) {
        return 'failed'
      }
      inbox.push(...outbox.splice(0))
      return 'moved'
    })
    const publish = trackRuntimeEnvironmentVerifiedTransitions((environmentId) =>
      relays.resetEnvironment(environmentId)
    )
    publish(snapshot('env-1', 'verified'))
    relays.arm('dispatch-1', 'env-1')
    // Four failures leave the relay in a 16 s backoff.
    await vi.advanceTimersByTimeAsync(14_000)

    publish(snapshot('env-1', 'unavailable'))
    workerUp = true
    publish(snapshot('env-1', 'verified'))
    await vi.advanceTimersByTimeAsync(0)

    expect(inbox).toEqual(['worker_done'])
    relays.clear()
  })
})
