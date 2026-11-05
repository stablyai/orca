import { afterEach, describe, expect, it, vi } from 'vitest'
import { FinishedWorkerMailRounds, type FinishedWorkerHostRound } from './finished-worker-relay'

describe('rounds for finished remote workers', () => {
  afterEach(() => vi.useRealTimers())

  it('runs one round per host at a time, even across a reset, and gives up on an unreachable host', async () => {
    vi.useFakeTimers()
    const calls: string[] = []
    let finishSlowRound: (round: FinishedWorkerHostRound) => void = () => {}
    const rounds = new FinishedWorkerMailRounds((environmentId) => {
      calls.push(environmentId)
      return environmentId === 'slow'
        ? new Promise((resolve) => (finishSlowRound = resolve))
        : Promise.resolve('unreachable')
    })

    rounds.ensure(['slow', 'down'])
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(calls.filter((id) => id === 'down')).toHaveLength(6)
    rounds.stop()
    rounds.ensure(['slow', 'slow'])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls.filter((id) => id === 'slow')).toHaveLength(1)

    // The round asked for meanwhile runs once the one in flight ends.
    finishSlowRound('done')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls.filter((id) => id === 'slow')).toHaveLength(2)
    finishSlowRound('done')
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(calls.filter((id) => id === 'slow')).toHaveLength(2)
    rounds.stop()
  })
})
