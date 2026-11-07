import { describe, expect, it, vi } from 'vitest'
import type { RuntimeHostStatusSnapshot } from '../../../shared/remote-runtime/host-status/runtime-host-status'
import { trackRuntimeEnvironmentVerifiedTransitions } from './runtime-environment-verified-transitions'

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
  it('reports a server once per transition into verified', () => {
    const listener = vi.fn()
    const publish = trackRuntimeEnvironmentVerifiedTransitions(listener)

    publish(snapshot('env-1', 'verified'))
    publish(snapshot('env-1', 'verified'))
    publish(snapshot('env-2', 'verified'))
    publish(snapshot('env-1', 'unavailable'))
    publish(snapshot('env-1', 'checking'))
    publish(snapshot('env-1', 'verified'))

    expect(listener.mock.calls).toEqual([['env-1'], ['env-2'], ['env-1']])
  })

  it.each([7, 70])('reports nothing for repeat publishes of %i healthy servers', (serverCount) => {
    const listener = vi.fn()
    const publish = trackRuntimeEnvironmentVerifiedTransitions(listener)
    for (let round = 0; round < 10; round += 1) {
      for (let index = 0; index < serverCount; index += 1) {
        publish(snapshot(`env-${index}`, 'verified'))
      }
    }

    // Required output is one transition per server, however often each healthy server republishes.
    expect(listener).toHaveBeenCalledTimes(serverCount)
  })
})
