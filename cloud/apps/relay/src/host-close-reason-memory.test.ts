import { ASSIGNMENT_LIMITS, RELAY_HOST_CLOSE_REASON } from '@orca-cloud/relay-contract'
import { describe, expect, it } from 'vitest'
import { HostCloseReasonMemory } from './host-close-reason-memory.js'

function memoryAt(clock: { now: number }): HostCloseReasonMemory {
  return new HostCloseReasonMemory(() => clock.now)
}

describe('HostCloseReasonMemory', () => {
  it('remembers only reasons it knows', () => {
    const clock = { now: 1_000 }
    const memory = memoryAt(clock)

    memory.record('a', RELAY_HOST_CLOSE_REASON.SIGNED_OUT)
    memory.record('b', 'quitting')
    memory.record('c', Buffer.alloc(0))
    memory.record('d', undefined)

    expect(memory.read('a')).toBe(RELAY_HOST_CLOSE_REASON.SIGNED_OUT)
    expect(memory.read('b')).toBeNull()
    expect(memory.read('c')).toBeNull()
    expect(memory.read('d')).toBeNull()
  })

  it('accepts the reason as the Buffer a ws close delivers', () => {
    const clock = { now: 1_000 }
    const memory = memoryAt(clock)

    memory.record('a', Buffer.from(RELAY_HOST_CLOSE_REASON.SIGNED_OUT))

    expect(memory.read('a')).toBe(RELAY_HOST_CLOSE_REASON.SIGNED_OUT)
  })

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

  it('forgets on demand', () => {
    const clock = { now: 1_000 }
    const memory = memoryAt(clock)
    memory.record('a', RELAY_HOST_CLOSE_REASON.SIGNED_OUT)

    memory.forget('a')

    expect(memory.read('a')).toBeNull()
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

  it('re-recording refreshes recency so a live host is not evicted first', () => {
    const clock = { now: 1_000 }
    const memory = memoryAt(clock)
    memory.record('a', RELAY_HOST_CLOSE_REASON.SIGNED_OUT)
    memory.record('b', RELAY_HOST_CLOSE_REASON.SIGNED_OUT)
    memory.record('a', RELAY_HOST_CLOSE_REASON.SIGNED_OUT)

    expect([...['a', 'b'].map((key) => memory.read(key))]).toEqual([
      RELAY_HOST_CLOSE_REASON.SIGNED_OUT,
      RELAY_HOST_CLOSE_REASON.SIGNED_OUT
    ])
    expect(memory.size()).toBe(2)
  })
})
