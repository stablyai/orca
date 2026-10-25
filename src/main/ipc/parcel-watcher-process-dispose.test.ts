import { describe, expect, it, vi } from 'vitest'

const { supervisorDispose, poolDispose } = vi.hoisted(() => ({
  supervisorDispose: vi.fn<() => Promise<void>>(),
  poolDispose: vi.fn<() => Promise<void>>()
}))

vi.mock('./parcel-watcher-process-supervisor', () => ({
  WatcherProcessSupervisor: class {
    disposeAndWait = supervisorDispose
  }
}))
vi.mock('./runtime-watcher-process-pool', () => ({
  RuntimeWatcherProcessPool: class {
    disposeAndWait = poolDispose
  }
}))

import { disposeWatcherProcessAndWait } from './parcel-watcher-process'

describe('disposeWatcherProcessAndWait', () => {
  it('waits for both watcher hosts, and reports a failed one only after the other settles', async () => {
    let finishPool!: () => void
    supervisorDispose.mockRejectedValueOnce(new Error('child still running'))
    poolDispose.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishPool = resolve
      })
    )
    const settled = vi.fn()
    const disposal = disposeWatcherProcessAndWait().catch((error: unknown) => {
      settled()
      throw error
    })
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    finishPool()
    await expect(disposal).rejects.toMatchObject({ message: 'watcher_process_shutdown_incomplete' })
  })

  it('resolves once every owned child has exited', async () => {
    supervisorDispose.mockResolvedValueOnce()
    poolDispose.mockResolvedValueOnce()
    await expect(disposeWatcherProcessAndWait()).resolves.toBeUndefined()
    expect(supervisorDispose).toHaveBeenCalled()
    expect(poolDispose).toHaveBeenCalled()
  })
})
