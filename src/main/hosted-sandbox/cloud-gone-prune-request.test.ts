import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestCloudGonePrune, setCloudGonePruneRunner } from './cloud-gone-prune-request'

afterEach(() => setCloudGonePruneRunner(null))

describe('requestCloudGonePrune (LC-2)', () => {
  it('runs the prune now instead of at the next relist, at most once per 30 s', async () => {
    const run = vi.fn(async () => {})
    setCloudGonePruneRunner(run)
    await requestCloudGonePrune(1_000)
    await requestCloudGonePrune(2_000)
    await requestCloudGonePrune(20_000)
    expect(run).toHaveBeenCalledTimes(1)
    await requestCloudGonePrune(31_001)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('is single-flight and survives a failing run', async () => {
    let release!: () => void
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    setCloudGonePruneRunner(run)
    const first = requestCloudGonePrune(1_000)
    void requestCloudGonePrune(100_000)
    expect(run).toHaveBeenCalledTimes(1)
    release()
    await first

    setCloudGonePruneRunner(async () => {
      throw new Error('offline')
    })
    await expect(requestCloudGonePrune(200_000)).resolves.toBeUndefined()
  })

  it('does nothing before the cloud is installed (no control plane)', async () => {
    await expect(requestCloudGonePrune(1_000)).resolves.toBeUndefined()
  })
})
