import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createPtySpawnPreparationDeadline,
  PTY_SPAWN_PREPARATION_DEADLINE_MS
} from './pty-spawn-preparation-deadline'

describe('PTY spawn preparation deadline', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('rejects the waiting operation and signals its owner at the deadline', async () => {
    const onTimeout = vi.fn()
    const deadline = createPtySpawnPreparationDeadline({ onTimeout })
    deadline.start()
    const result = deadline.race(new Promise(() => {}))
    void result.catch(() => {})

    await vi.advanceTimersByTimeAsync(PTY_SPAWN_PREPARATION_DEADLINE_MS)

    await expect(result).rejects.toThrow('preparation timed out')
    expect(onTimeout).toHaveBeenCalledOnce()
    expect(() => deadline.assertPreparing()).toThrow('preparation timed out')
  })

  it('fences a provider call when preparation completes after expiry', async () => {
    const onTimeout = vi.fn()
    const deadline = createPtySpawnPreparationDeadline({ onTimeout })
    let releasePreparation!: () => void
    const preparation = new Promise<void>((resolve) => {
      releasePreparation = resolve
    })
    deadline.start()
    const providerSpawn = vi.fn()
    const result = deadline.race(
      (async () => {
        await preparation
        deadline.assertPreparing()
        providerSpawn()
      })()
    )
    void result.catch(() => {})

    await vi.advanceTimersByTimeAsync(PTY_SPAWN_PREPARATION_DEADLINE_MS)
    await expect(result).rejects.toThrow('preparation timed out')
    releasePreparation()
    await vi.runAllTicks()

    expect(providerSpawn).not.toHaveBeenCalled()
  })
})
