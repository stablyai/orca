import { describe, expect, it, vi } from 'vitest'
import { RuntimeWatcherPendingAssignment } from './runtime-watcher-pending-assignment'

describe('RuntimeWatcherPendingAssignment', () => {
  it('removes ten thousand cancelled assignment callers while one anchor remains', async () => {
    let resolveAssignment: (value: number) => void = () => undefined
    const assignment = new RuntimeWatcherPendingAssignment(
      new Promise<number>((resolve) => {
        resolveAssignment = resolve
      }),
      vi.fn(),
      vi.fn()
    )
    const anchor = assignment.wait({}, vi.fn())
    const controllers = Array.from({ length: 10_000 }, () => new AbortController())
    const cancelled = controllers.map((controller) =>
      assignment.wait({ signal: controller.signal }, vi.fn()).catch((error) => error)
    )

    for (const controller of controllers) {
      controller.abort()
    }
    await Promise.all(cancelled)

    expect(assignment.waiterCount).toBe(1)
    resolveAssignment(42)
    await expect(anchor).resolves.toBe(42)
    expect(assignment.waiterCount).toBe(0)
  })

  it('releases ownership for an already-aborted first caller', async () => {
    const controller = new AbortController()
    controller.abort()
    const onNoWaiters = vi.fn()
    const onSettled = vi.fn()
    const assignment = new RuntimeWatcherPendingAssignment(
      new Promise<void>(() => {}),
      onNoWaiters,
      onSettled
    )

    await expect(assignment.wait({ signal: controller.signal }, vi.fn())).rejects.toMatchObject({
      code: 'subscribe_aborted'
    })

    expect(onNoWaiters).toHaveBeenCalledOnce()
    expect(onSettled).toHaveBeenCalledOnce()
    expect(assignment.waiterCount).toBe(0)
  })
})
