import { describe, expect, it } from 'vitest'
import { DaemonConnectAttempt } from './daemon-client-connect-attempt'

/** A connect that never settles on its own, standing in for a dial that has gone quiet. */
function stalledConnect(): {
  connect: () => Promise<void>
  finish: () => void
  calls: () => number
} {
  let calls = 0
  let finish: () => void = () => {}
  return {
    connect: () => {
      calls += 1
      return new Promise<void>((resolve) => {
        finish = resolve
      })
    },
    finish: () => finish(),
    calls: () => calls
  }
}

describe('DaemonConnectAttempt', () => {
  it('bounds the wait on a retired attempt by the caller’s join budget', async () => {
    const stalled = stalledConnect()
    let generation = 1
    const attempt = new DaemonConnectAttempt()
    const owner = attempt
      .run({
        isConnected: () => false,
        currentGeneration: () => generation,
        connect: stalled.connect,
        joinTimeoutMs: 20_000
      })
      .catch(() => {})

    generation = 2

    await expect(
      attempt.run({
        isConnected: () => false,
        currentGeneration: () => generation,
        connect: stalled.connect,
        joinTimeoutMs: 25
      })
    ).rejects.toThrow('Connection attempt wait timed out')

    stalled.finish()
    await owner
  })

  it('does not start a second dial when that bound expires', async () => {
    const stalled = stalledConnect()
    let generation = 1
    const attempt = new DaemonConnectAttempt()
    const owner = attempt
      .run({
        isConnected: () => false,
        currentGeneration: () => generation,
        connect: stalled.connect,
        joinTimeoutMs: 20_000
      })
      .catch(() => {})

    generation = 2
    await attempt
      .run({
        isConnected: () => false,
        currentGeneration: () => generation,
        connect: stalled.connect,
        joinTimeoutMs: 25
      })
      .catch(() => {})

    // The single-owner invariant on the client's socket fields: the retired dial
    // still owns them, so giving up on the wait must not race a second one in.
    expect(stalled.calls()).toBe(1)
    expect(attempt.hasInFlight()).toBe(true)

    stalled.finish()
    await owner
  })

  it('still redials the replacement once the retired attempt settles in time', async () => {
    const stalled = stalledConnect()
    let generation = 1
    const attempt = new DaemonConnectAttempt()
    const owner = attempt
      .run({
        isConnected: () => false,
        currentGeneration: () => generation,
        connect: stalled.connect,
        joinTimeoutMs: 20_000
      })
      .catch(() => {})

    generation = 2
    const redialed: number[] = []
    const joiner = attempt.run({
      isConnected: () => false,
      currentGeneration: () => generation,
      connect: async (attemptGeneration) => {
        redialed.push(attemptGeneration)
      },
      joinTimeoutMs: 1000
    })

    stalled.finish()
    await owner
    await expect(joiner).resolves.toBeUndefined()
    expect(redialed).toEqual([2])
  })
})
