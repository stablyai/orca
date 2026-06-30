import { describe, expect, it } from 'vitest'
import { runPipelineIterationLoop } from './iteration-loop'

describe('runPipelineIterationLoop', () => {
  it('continues after progress and stops when planner returns no tasks', async () => {
    const iterations: number[] = []

    const result = await runPipelineIterationLoop({
      maxIterations: 3,
      runIteration: async (iterationNumber) => {
        iterations.push(iterationNumber)
        return iterationNumber === 1
          ? { status: 'completed', plannedTaskCount: 1, completedTaskCount: 1 }
          : { status: 'completed', plannedTaskCount: 0, completedTaskCount: 0 }
      }
    })

    expect(iterations).toEqual([1, 2])
    expect(result.stopReason).toBe('empty_plan')
  })

  it('stops when an iteration makes no progress', async () => {
    const result = await runPipelineIterationLoop({
      maxIterations: 3,
      runIteration: async () => ({
        status: 'completed',
        plannedTaskCount: 2,
        completedTaskCount: 0
      })
    })

    expect(result.stopReason).toBe('no_progress')
    expect(result.iterations).toHaveLength(1)
  })

  it('stops at maxIterations while work can remain', async () => {
    const result = await runPipelineIterationLoop({
      maxIterations: 2,
      runIteration: async () => ({
        status: 'completed',
        plannedTaskCount: 1,
        completedTaskCount: 1
      })
    })

    expect(result.stopReason).toBe('max_iterations')
    expect(result.iterations).toHaveLength(2)
  })

  it('stops immediately on failure or cancellation', async () => {
    const failed = await runPipelineIterationLoop({
      maxIterations: 3,
      runIteration: async () => ({
        status: 'failed',
        plannedTaskCount: 1,
        completedTaskCount: 0
      })
    })
    const cancelled = await runPipelineIterationLoop({
      maxIterations: 3,
      runIteration: async () => ({
        status: 'cancelled',
        plannedTaskCount: 1,
        completedTaskCount: 0
      })
    })

    expect(failed.stopReason).toBe('failed')
    expect(cancelled.stopReason).toBe('cancelled')
  })
})
