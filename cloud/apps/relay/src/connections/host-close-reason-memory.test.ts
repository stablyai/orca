import { ASSIGNMENT_LIMITS } from '@orca-cloud/relay-contract/assignment-invariants'
import { RELAY_HOST_CLOSE_REASON } from '@orca-cloud/relay-contract/host-close-reason'
import { describe, expect, it } from 'vitest'
import { HostCloseReasonMemory } from './host-close-reason-memory.js'

function memoryAt(clock: { now: number }): HostCloseReasonMemory {
  return new HostCloseReasonMemory(() => clock.now)
}

describe('HostCloseReasonMemory', () => {

  it('expires an entry once its host may have been rebalanced away', () => {
    const clock = { now: 1_000 }
    const memory = memoryAt(clock)
    memory.record('a', RELAY_HOST_CLOSE_REASON.SIGNED_OUT)

    clock.now += ASSIGNMENT_LIMITS.dormantTtlMs - 1
    expect(memory.read('a')).toBe(RELAY_HOST_CLOSE_REASON.SIGNED_OUT)

    clock.now += 1
    expect(memory.read('a')).toBeNull()
    expect(memory.size()).toBe(0)
  })

  it('drops the oldest survivors rather than growing without bound', () => {
    const clock = { now: 1_000 }
    const memory = memoryAt(clock)
    for (let index = 0; index < 50_050; index++) {
      memory.record(`host-${index}`, RELAY_HOST_CLOSE_REASON.SIGNED_OUT)
    }

    expect(memory.size()).toBe(50_000)
    expect(memory.read('host-0')).toBeNull()
    expect(memory.read('host-50049')).toBe(RELAY_HOST_CLOSE_REASON.SIGNED_OUT)
  })

})
