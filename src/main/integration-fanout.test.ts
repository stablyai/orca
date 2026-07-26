import { describe, expect, it } from 'vitest'
import {
  runBoundedIntegrationFanout,
  runBoundedIntegrationSettledFanout
} from './integration-fanout'

describe('runBoundedIntegrationFanout', () => {
  it('bounds concurrency and preserves input order across out-of-order completions', async () => {
    let active = 0
    let peak = 0
    const result = await runBoundedIntegrationFanout(
      [0, 1, 2, 3, 4],
      async (entry) => {
        active += 1
        peak = Math.max(peak, active)
        await new Promise((resolve) => setTimeout(resolve, (4 - entry) % 3))
        active -= 1
        return [entry]
      },
      (items) => items,
      {
        maxConcurrent: 2,
        limits: { maxPages: 5, maxItems: 5, maxRetainedBytes: 100 }
      }
    )

    expect(peak).toBe(2)
    expect(result).toEqual({
      results: [[0], [1], [2], [3], [4]],
      truncated: false,
      attemptedCount: 5
    })
  })

  it('admits the exact aggregate item boundary and stops scheduling after item +1', async () => {
    const visited: number[] = []
    const result = await runBoundedIntegrationFanout(
      [0, 1, 2, 3],
      async (entry) => {
        visited.push(entry)
        return [entry]
      },
      (items) => items,
      {
        maxConcurrent: 2,
        limits: { maxPages: 4, maxItems: 2, maxRetainedBytes: 100 }
      }
    )

    expect(result).toEqual({
      results: [[0], [1]],
      truncated: true,
      attemptedCount: 2
    })
    expect(visited).toEqual([0, 1])
  })

  it('does not retain or schedule later batches after byte +1', async () => {
    const visited: number[] = []
    const result = await runBoundedIntegrationFanout(
      [0, 1, 2],
      async (entry) => {
        visited.push(entry)
        return entry === 0 ? ['a'] : ['aa']
      },
      (items) => items,
      {
        maxConcurrent: 1,
        limits: { maxPages: 3, maxItems: 3, maxRetainedBytes: 10 }
      }
    )

    expect(result).toEqual({
      results: [['a']],
      truncated: true,
      attemptedCount: 2
    })
    expect(visited).toEqual([0, 1])
  })

  it('preserves settled success and failure order without rejecting the fan-out', async () => {
    const result = await runBoundedIntegrationSettledFanout(
      ['ok', 'bad', 'later'],
      async (entry) => {
        if (entry === 'bad') {
          throw new Error('failed')
        }
        return [entry]
      },
      (items) => items
    )

    expect(result.results).toMatchObject([
      { status: 'fulfilled', value: ['ok'] },
      { status: 'rejected', reason: { message: 'failed' } },
      { status: 'fulfilled', value: ['later'] }
    ])
  })
})
