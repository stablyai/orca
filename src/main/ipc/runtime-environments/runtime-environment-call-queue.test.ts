import { expect, it } from 'vitest'
import { enqueueRuntimeCall } from './runtime-environment-call-queue'

it('passes timed intent to the desktop queue without holding status or manual PR reads', async () => {
  const release = Promise.withResolvers<void>()
  const waiting = [0, 1].map(() =>
    enqueueRuntimeCall('host', 'github.prForBranch', () => release.promise, undefined, {
      reason: 'swr'
    })
  )
  await expect(
    enqueueRuntimeCall('host', 'github.prForBranch', async () => 'current', undefined, {
      reason: 'manual'
    })
  ).resolves.toBe('current')
  await expect(enqueueRuntimeCall('host', 'git.status', async () => 'clean')).resolves.toBe('clean')
  release.resolve()
  await Promise.all(waiting)
})
