import { describe, expect, it, vi } from 'vitest'
import {
  CANCELED_GENERATION_RESULT,
  cancelLocalGeneration,
  clearLocalGenerationCancelToken,
  localGenerationLaneKey,
  runCancelableLocalGeneration,
  setLocalGenerationCancelToken
} from './source-control-generation-lanes'

describe('runCancelableLocalGeneration', () => {
  it('settles as canceled when cancel lands before the agent spawns', async () => {
    const preparation = Promise.withResolvers<void>()
    const spawn = vi.fn()
    const run = runCancelableLocalGeneration('commit-message', '/repo', async (isCanceled) => {
      await preparation.promise
      if (isCanceled()) {
        return 'skipped'
      }
      spawn()
      return 'spawned'
    })

    cancelLocalGeneration('commit-message', '/repo')

    await expect(run).resolves.toBe(CANCELED_GENERATION_RESULT)
    preparation.resolve()
    await preparation.promise
    expect(spawn).not.toHaveBeenCalled()
  })

  it('hands cancel to the token a spawned agent installs over the pending one', async () => {
    const laneKey = localGenerationLaneKey('commit-message', '/repo')
    const killAgent = vi.fn()
    const agent = Promise.withResolvers<string>()
    const run = runCancelableLocalGeneration('commit-message', '/repo', () => {
      setLocalGenerationCancelToken(laneKey, killAgent)
      return agent.promise.finally(() => clearLocalGenerationCancelToken(laneKey, killAgent))
    })

    cancelLocalGeneration('commit-message', '/repo')
    expect(killAgent).toHaveBeenCalledOnce()
    agent.resolve('agent canceled')
    await expect(run).resolves.toBe('agent canceled')
  })

  it('leaves a newer request cancelable after an older one on the lane finishes', async () => {
    const older = runCancelableLocalGeneration('commit-message', '/repo', async () => 'older')
    const newerPreparation = Promise.withResolvers<string>()
    const newer = runCancelableLocalGeneration(
      'commit-message',
      '/repo',
      () => newerPreparation.promise
    )
    await expect(older).resolves.toBe('older')

    cancelLocalGeneration('commit-message', '/repo')

    await expect(newer).resolves.toBe(CANCELED_GENERATION_RESULT)
    newerPreparation.resolve('late')
  })
})
