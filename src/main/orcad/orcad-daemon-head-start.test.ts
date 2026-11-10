import { describe, expect, it, vi } from 'vitest'
import { daemonLaunchHeadStart } from './orcad-daemon-supervision'

vi.mock('../daemon/providers/lifecycle/daemon-provider-init', () => ({
  initDaemonPtyProvider: vi.fn()
}))

const never = new Promise<never>(() => {})

describe('daemonLaunchHeadStart', () => {
  it('resolves when the daemon child forks', async () => {
    let fork!: () => void
    const spawned = new Promise<void>((resolve) => (fork = resolve))
    const wait = daemonLaunchHeadStart(never, 10_000, spawned)
    fork()
    await expect(wait).resolves.toBeUndefined()
  })

  it('resolves when startup settles without a fork, even by rejecting', async () => {
    await expect(daemonLaunchHeadStart(Promise.resolve(), 10_000, never)).resolves.toBeUndefined()
    await expect(
      daemonLaunchHeadStart(Promise.reject(new Error('no daemon')), 10_000, never)
    ).resolves.toBeUndefined()
  })

  it('stops waiting after its bound', async () => {
    vi.useFakeTimers()
    try {
      const wait = daemonLaunchHeadStart(never, 50, never)
      await vi.advanceTimersByTimeAsync(50)
      await expect(wait).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})
