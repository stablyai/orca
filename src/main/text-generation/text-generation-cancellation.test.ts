import { expect, it, vi } from 'vitest'
import {
  beginTextGenerationCancellation,
  cancelTextGeneration,
  localTextGenerationLane,
  runCancelableTextGenerationRequest,
  sshTextGenerationLane
} from './text-generation-cancellation'

it('settles a request immediately while pre-spawn work remains pending', async () => {
  let releaseWork = (): void => {}
  const work = new Promise<void>((resolve) => {
    releaseWork = resolve
  })
  const reachedAfterWork = vi.fn()

  const pending = runCancelableTextGenerationRequest(
    'commit-message',
    localTextGenerationLane('/repo'),
    'canceled',
    async (cancellation) => {
      await work
      if (!cancellation.isCanceled()) {
        reachedAfterWork()
      }
      return 'completed'
    }
  )

  cancelTextGeneration('commit-message', localTextGenerationLane('/repo'))

  await expect(pending).resolves.toBe('canceled')
  expect(reachedAfterWork).not.toHaveBeenCalled()

  releaseWork()
  await work
  await Promise.resolve()
  expect(reachedAfterWork).not.toHaveBeenCalled()
})

it('does not let an older request clear a newer request in the same lane', () => {
  const lane = localTextGenerationLane('/repo')
  const older = beginTextGenerationCancellation('commit-message', lane)
  const newer = beginTextGenerationCancellation('commit-message', lane)

  older.finish()
  cancelTextGeneration('commit-message', lane)

  expect(older.isCanceled()).toBe(false)
  expect(newer.isCanceled()).toBe(true)
  newer.finish()
})

it('runs an attached cancellation action only once', () => {
  const lane = localTextGenerationLane('/repo')
  const cancellation = beginTextGenerationCancellation('commit-message', lane)
  const action = vi.fn()
  cancellation.attach(action)

  cancelTextGeneration('commit-message', lane)
  cancelTextGeneration('commit-message', lane)

  expect(action).toHaveBeenCalledTimes(1)
  cancellation.finish()
})

it('isolates identical paths across local and SSH hosts', () => {
  const local = beginTextGenerationCancellation('commit-message', localTextGenerationLane('/repo'))
  const remote = beginTextGenerationCancellation(
    'commit-message',
    sshTextGenerationLane('connection-1', '/repo')
  )

  cancelTextGeneration('commit-message', sshTextGenerationLane('connection-1', '/repo'))

  expect(local.isCanceled()).toBe(false)
  expect(remote.isCanceled()).toBe(true)
  local.finish()
  remote.finish()
})
