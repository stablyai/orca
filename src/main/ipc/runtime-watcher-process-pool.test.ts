import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WatcherProcessFailure } from './parcel-watcher-process-failure'
import type {
  WatcherProcessCallback,
  WatcherProcessHooks,
  WatcherProcessSubscription
} from './parcel-watcher-process-subscription'
import { RuntimeWatcherProcessPool } from './runtime-watcher-process-pool'

type InstalledSubscription = {
  dir: string
  hooks: WatcherProcessHooks
  unsubscribe: ReturnType<typeof vi.fn<() => Promise<void>>>
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

class FakeSupervisor {
  readonly subscriptions: InstalledSubscription[] = []
  readonly dispose = vi.fn()
  subscribeError?: Error

  async subscribe(
    dir: string,
    _callback: WatcherProcessCallback,
    _opts: object,
    hooks: WatcherProcessHooks
  ): Promise<WatcherProcessSubscription> {
    if (this.subscribeError) {
      throw this.subscribeError
    }
    const unsubscribe = vi.fn(async () => undefined)
    this.subscriptions.push({ dir, hooks, unsubscribe })
    return { unsubscribe }
  }
}

describe('RuntimeWatcherProcessPool', () => {
  let supervisors: FakeSupervisor[]
  let pool: RuntimeWatcherProcessPool

  beforeEach(() => {
    supervisors = []
    pool = new RuntimeWatcherProcessPool({
      createSupervisor: () => {
        const supervisor = new FakeSupervisor()
        supervisors.push(supervisor)
        return supervisor
      }
    })
  })

  it('shares one healthy child until a fault requires quarantine isolation', async () => {
    for (const dir of ['/a', '/b', '/c', '/d', '/e']) {
      await pool.subscribe(dir, vi.fn(), {}, {})
    }

    expect(supervisors).toHaveLength(1)
    expect(supervisors.map((supervisor) => supervisor.subscriptions.map(({ dir }) => dir))).toEqual(
      [['/a', '/b', '/c', '/d', '/e']]
    )
  })

  it('keeps a newer same-root lease assigned while an older lease tears down', async () => {
    const first = await pool.subscribe('/same', vi.fn(), {}, {})
    await pool.subscribe('/same', vi.fn(), {}, {})

    await first.unsubscribe()
    await pool.subscribe('/same', vi.fn(), {}, {})

    expect(supervisors).toHaveLength(1)
    expect(supervisors[0].subscriptions.map(({ dir }) => dir)).toEqual(['/same', '/same', '/same'])
  })

  it('isolates every root from a failed shard when callers recover', async () => {
    pool = new RuntimeWatcherProcessPool({
      maxSharedSupervisors: 1,
      createSupervisor: () => {
        const supervisor = new FakeSupervisor()
        supervisors.push(supervisor)
        return supervisor
      }
    })
    const firstError = vi.fn()
    const secondError = vi.fn()
    await pool.subscribe('/a', vi.fn(), {}, { onTerminalError: firstError })
    await pool.subscribe('/b', vi.fn(), {}, { onTerminalError: secondError })
    const failedShard = supervisors[0]
    const failure = new WatcherProcessFailure(
      'file watcher process crashed repeatedly',
      'supervisor',
      'supervisor_crash_fuse'
    )

    for (const installed of failedShard.subscriptions) {
      installed.hooks.onTerminalError?.(failure)
    }
    await pool.subscribe('/a', vi.fn(), {}, {})
    await pool.subscribe('/b', vi.fn(), {}, {})

    expect(firstError).toHaveBeenCalledWith(failure)
    expect(secondError).toHaveBeenCalledWith(failure)
    expect(supervisors).toHaveLength(3)
    expect(supervisors[1].subscriptions.map(({ dir }) => dir)).toEqual(['/a'])
    expect(supervisors[2].subscriptions.map(({ dir }) => dir)).toEqual(['/b'])
  })

  it('does not assign a replacement until the failed child physically exits', async () => {
    const physicalExit = deferred()
    await pool.subscribe('/held', vi.fn(), {}, {})
    const failure = new WatcherProcessFailure(
      'file watcher process did not exit after termination deadline',
      'supervisor',
      'process_unavailable',
      physicalExit.promise
    )

    supervisors[0].subscriptions[0].hooks.onTerminalError?.(failure)

    await expect(pool.subscribe('/held', vi.fn(), {}, {})).rejects.toBe(failure)
    expect(supervisors).toHaveLength(1)

    physicalExit.resolve()
    await physicalExit.promise
    await expect(pool.subscribe('/held', vi.fn(), {}, {})).resolves.toBeDefined()

    expect(supervisors).toHaveLength(2)
    expect(supervisors[1].subscriptions.map(({ dir }) => dir)).toEqual(['/held'])
  })

  it('bounds single-root quarantine supervisors and their wait queue', async () => {
    pool = new RuntimeWatcherProcessPool({
      maxSharedSupervisors: 1,
      createSupervisor: () => {
        const supervisor = new FakeSupervisor()
        supervisors.push(supervisor)
        return supervisor
      }
    })
    const roots = Array.from({ length: 9 }, (_, index) => `/root-${index}`)
    for (const root of roots) {
      await pool.subscribe(root, vi.fn(), {}, {})
    }
    const failedShard = supervisors[0]
    const failure = new WatcherProcessFailure(
      'file watcher process crashed repeatedly',
      'supervisor',
      'supervisor_crash_fuse'
    )

    for (const installed of failedShard.subscriptions) {
      installed.hooks.onTerminalError?.(failure)
    }
    const recoveries = roots.map((root) => pool.subscribe(root, vi.fn(), {}, {}))
    const queueOverflow = expect(recoveries[8]).rejects.toThrow('quarantine capacity exhausted')
    const active = await Promise.all(recoveries.slice(0, 4))

    expect(supervisors).toHaveLength(5)
    expect(supervisors.slice(1).map(({ subscriptions }) => subscriptions.length)).toEqual([
      1, 1, 1, 1
    ])

    for (let index = 0; index < active.length; index++) {
      await active[index].unsubscribe()
      await expect(recoveries[index + 4]).resolves.toBeDefined()
    }
    await queueOverflow

    expect(supervisors).toHaveLength(5)
    expect(supervisors.slice(1).map(({ subscriptions }) => subscriptions.length)).toEqual([
      2, 2, 2, 2
    ])
  })

  it('does not fail a healthy queued root when a quarantine root fuses again', async () => {
    pool = new RuntimeWatcherProcessPool({
      maxSharedSupervisors: 1,
      maxQuarantineSupervisors: 1,
      createSupervisor: () => {
        const supervisor = new FakeSupervisor()
        supervisors.push(supervisor)
        return supervisor
      }
    })
    const failure = new WatcherProcessFailure(
      'file watcher process crashed repeatedly',
      'supervisor',
      'supervisor_crash_fuse'
    )
    await pool.subscribe('/poison', vi.fn(), {}, {})
    await pool.subscribe('/healthy', vi.fn(), {}, {})
    for (const installed of supervisors[0].subscriptions) {
      installed.hooks.onTerminalError?.(failure)
    }

    await pool.subscribe('/poison', vi.fn(), {}, {})
    const healthyRecovery = pool.subscribe('/healthy', vi.fn(), {}, {})
    supervisors[1].subscriptions[0].hooks.onTerminalError?.(failure)

    await expect(healthyRecovery).resolves.toBeDefined()
    await expect(pool.subscribe('/poison', vi.fn(), {}, {})).rejects.toThrow(
      'failed again in quarantine'
    )
    expect(supervisors[1].subscriptions.map(({ dir }) => dir)).toEqual(['/poison'])
    expect(supervisors[2].subscriptions.map(({ dir }) => dir)).toEqual(['/healthy'])
  })

  it('bounds how long a root can wait for quarantine capacity', async () => {
    vi.useFakeTimers()
    try {
      pool = new RuntimeWatcherProcessPool({
        maxSharedSupervisors: 1,
        maxQuarantineSupervisors: 1,
        createSupervisor: () => {
          const supervisor = new FakeSupervisor()
          supervisors.push(supervisor)
          return supervisor
        }
      })
      const failure = new WatcherProcessFailure(
        'file watcher process crashed repeatedly',
        'supervisor',
        'supervisor_crash_fuse'
      )
      await pool.subscribe('/occupied', vi.fn(), {}, {})
      await pool.subscribe('/waiting', vi.fn(), {}, {})
      for (const installed of supervisors[0].subscriptions) {
        installed.hooks.onTerminalError?.(failure)
      }
      await pool.subscribe('/occupied', vi.fn(), {}, {})

      const waiting = pool.subscribe('/waiting', vi.fn(), {}, { subscribeTimeoutMs: 25 })
      const timedOut = expect(waiting).rejects.toThrow('timed out waiting for quarantine capacity')
      await vi.advanceTimersByTimeAsync(25)

      await timedOut
      expect(supervisors).toHaveLength(2)
    } finally {
      pool.dispose()
      expect(vi.getTimerCount()).toBe(0)
      vi.useRealTimers()
    }
  })

  it('dedupes concurrent same-root assignments waiting for quarantine capacity', async () => {
    pool = new RuntimeWatcherProcessPool({
      maxSharedSupervisors: 1,
      maxQuarantineSupervisors: 1,
      createSupervisor: () => {
        const supervisor = new FakeSupervisor()
        supervisors.push(supervisor)
        return supervisor
      }
    })
    const failure = new WatcherProcessFailure(
      'file watcher process crashed repeatedly',
      'supervisor',
      'supervisor_crash_fuse'
    )
    await pool.subscribe('/occupied', vi.fn(), {}, {})
    await pool.subscribe('/same', vi.fn(), {}, {})
    for (const installed of supervisors[0].subscriptions) {
      installed.hooks.onTerminalError?.(failure)
    }
    const occupied = await pool.subscribe('/occupied', vi.fn(), {}, {})
    const first = pool.subscribe('/same', vi.fn(), {}, {})
    const second = pool.subscribe('/same', vi.fn(), {}, {})

    await occupied.unsubscribe()
    const [firstSubscription, secondSubscription] = await Promise.all([first, second])

    expect(supervisors).toHaveLength(2)
    expect(supervisors[1].subscriptions.map(({ dir }) => dir)).toEqual([
      '/occupied',
      '/same',
      '/same'
    ])
    await firstSubscription.unsubscribe()
    await secondSubscription.unsubscribe()
  })

  it('keeps a healthy same-root quarantine waiter when the first waiter aborts', async () => {
    pool = new RuntimeWatcherProcessPool({
      maxSharedSupervisors: 1,
      maxQuarantineSupervisors: 1,
      createSupervisor: () => {
        const supervisor = new FakeSupervisor()
        supervisors.push(supervisor)
        return supervisor
      }
    })
    const failure = new WatcherProcessFailure(
      'file watcher process crashed repeatedly',
      'supervisor',
      'supervisor_crash_fuse'
    )
    await pool.subscribe('/occupied', vi.fn(), {}, {})
    await pool.subscribe('/same', vi.fn(), {}, {})
    for (const installed of supervisors[0].subscriptions) {
      installed.hooks.onTerminalError?.(failure)
    }
    const occupied = await pool.subscribe('/occupied', vi.fn(), {}, {})
    const firstController = new AbortController()
    const first = pool.subscribe('/same', vi.fn(), {}, { signal: firstController.signal })
    const second = pool.subscribe('/same', vi.fn(), {}, {})

    firstController.abort()
    await expect(first).rejects.toMatchObject({ code: 'subscribe_aborted' })
    await occupied.unsubscribe()
    const secondSubscription = await second

    expect(supervisors[1].subscriptions.map(({ dir }) => dir)).toEqual(['/occupied', '/same'])
    await secondSubscription.unsubscribe()
  })

  it('does not let an aborted zero-waiter assignment poison a same-turn replacement', async () => {
    pool = new RuntimeWatcherProcessPool({
      maxSharedSupervisors: 1,
      maxQuarantineSupervisors: 1,
      createSupervisor: () => {
        const supervisor = new FakeSupervisor()
        supervisors.push(supervisor)
        return supervisor
      }
    })
    const failure = new WatcherProcessFailure(
      'file watcher process crashed repeatedly',
      'supervisor',
      'supervisor_crash_fuse'
    )
    await pool.subscribe('/occupied', vi.fn(), {}, {})
    await pool.subscribe('/same', vi.fn(), {}, {})
    for (const installed of supervisors[0].subscriptions) {
      installed.hooks.onTerminalError?.(failure)
    }
    const occupied = await pool.subscribe('/occupied', vi.fn(), {}, {})
    const controller = new AbortController()
    const abandoned = pool.subscribe('/same', vi.fn(), {}, { signal: controller.signal })

    controller.abort()
    const replacement = pool.subscribe('/same', vi.fn(), {}, {})
    await expect(abandoned).rejects.toMatchObject({ code: 'subscribe_aborted' })
    await occupied.unsubscribe()
    const replacementSubscription = await replacement

    expect(supervisors[1].subscriptions.map(({ dir }) => dir)).toEqual(['/occupied', '/same'])
    await replacementSubscription.unsubscribe()
  })

  it('rejects an aborted later same-root waiter without cancelling the first', async () => {
    pool = new RuntimeWatcherProcessPool({
      maxSharedSupervisors: 1,
      maxQuarantineSupervisors: 1,
      createSupervisor: () => {
        const supervisor = new FakeSupervisor()
        supervisors.push(supervisor)
        return supervisor
      }
    })
    const failure = new WatcherProcessFailure(
      'file watcher process crashed repeatedly',
      'supervisor',
      'supervisor_crash_fuse'
    )
    await pool.subscribe('/occupied', vi.fn(), {}, {})
    await pool.subscribe('/same', vi.fn(), {}, {})
    for (const installed of supervisors[0].subscriptions) {
      installed.hooks.onTerminalError?.(failure)
    }
    const occupied = await pool.subscribe('/occupied', vi.fn(), {}, {})
    const first = pool.subscribe('/same', vi.fn(), {}, {})
    const secondController = new AbortController()
    const second = pool.subscribe('/same', vi.fn(), {}, { signal: secondController.signal })

    secondController.abort()
    await expect(second).rejects.toMatchObject({ code: 'subscribe_aborted' })
    let firstSettled = false
    void first.finally(() => {
      firstSettled = true
    })
    await Promise.resolve()
    expect(firstSettled).toBe(false)

    await occupied.unsubscribe()
    const firstSubscription = await first
    expect(supervisors[1].subscriptions.map(({ dir }) => dir)).toEqual(['/occupied', '/same'])
    await firstSubscription.unsubscribe()
  })

  it('releases a granted assignment when its last waiter aborts before lease publication', async () => {
    pool = new RuntimeWatcherProcessPool({
      maxSharedSupervisors: 1,
      maxQuarantineSupervisors: 1,
      createSupervisor: () => {
        const supervisor = new FakeSupervisor()
        supervisors.push(supervisor)
        return supervisor
      }
    })
    const failure = new WatcherProcessFailure(
      'file watcher process crashed repeatedly',
      'supervisor',
      'supervisor_crash_fuse'
    )
    for (const root of ['/occupied', '/aborted', '/following']) {
      await pool.subscribe(root, vi.fn(), {}, {})
    }
    for (const installed of supervisors[0].subscriptions) {
      installed.hooks.onTerminalError?.(failure)
    }
    const occupied = await pool.subscribe('/occupied', vi.fn(), {}, {})
    const controller = new AbortController()
    const aborted = pool.subscribe('/aborted', vi.fn(), {}, { signal: controller.signal })

    const release = occupied.unsubscribe()
    queueMicrotask(() => controller.abort())
    await release

    await expect(aborted).rejects.toMatchObject({ code: 'subscribe_aborted' })
    const following = pool.subscribe('/following', vi.fn(), {}, { subscribeTimeoutMs: 25 })
    const followingSubscription = await following
    expect(supervisors).toHaveLength(3)
    expect(supervisors[2].subscriptions.map(({ dir }) => dir)).toEqual(['/following'])
    expect(supervisors[1].dispose).toHaveBeenCalledTimes(1)
    await followingSubscription.unsubscribe()
  })

  it('moves an explicitly timed-out root into quarantine for its retry', async () => {
    const timeout = new WatcherProcessFailure(
      'file watcher subscription timed out',
      'subscription',
      'subscribe_timeout'
    )
    pool = new RuntimeWatcherProcessPool({
      maxSharedSupervisors: 1,
      createSupervisor: () => {
        const supervisor = new FakeSupervisor()
        if (supervisors.length === 0) {
          supervisor.subscribeError = timeout
        }
        supervisors.push(supervisor)
        return supervisor
      }
    })

    await expect(pool.subscribe('/slow', vi.fn(), {}, {})).rejects.toBe(timeout)
    await expect(pool.subscribe('/slow', vi.fn(), {}, {})).resolves.toBeDefined()

    expect(supervisors).toHaveLength(2)
    expect(supervisors[1].subscriptions.map(({ dir }) => dir)).toEqual(['/slow'])
  })

  it('allows only one quarantine generation when isolated setup also times out', async () => {
    const timeout = new WatcherProcessFailure(
      'file watcher subscription timed out',
      'subscription',
      'subscribe_timeout'
    )
    pool = new RuntimeWatcherProcessPool({
      maxSharedSupervisors: 1,
      createSupervisor: () => {
        const supervisor = new FakeSupervisor()
        supervisor.subscribeError = timeout
        supervisors.push(supervisor)
        return supervisor
      }
    })

    await expect(pool.subscribe('/slow', vi.fn(), {}, {})).rejects.toBe(timeout)
    await expect(pool.subscribe('/slow', vi.fn(), {}, {})).rejects.toBe(timeout)
    await expect(pool.subscribe('/slow', vi.fn(), {}, {})).rejects.toMatchObject({
      code: 'supervisor_crash_fuse'
    })
    expect(supervisors).toHaveLength(2)
  })

  it('moves a live root into quarantine when crash resubscription times out', async () => {
    const timeout = new WatcherProcessFailure(
      'file watcher resubscription timed out',
      'subscription',
      'subscribe_timeout'
    )
    const onTerminalError = vi.fn()
    await pool.subscribe('/slow-recovery', vi.fn(), {}, { onTerminalError })

    supervisors[0].subscriptions[0].hooks.onTerminalError?.(timeout)
    await pool.subscribe('/slow-recovery', vi.fn(), {}, {})

    expect(onTerminalError).toHaveBeenCalledWith(timeout)
    expect(supervisors).toHaveLength(2)
    expect(supervisors[1].subscriptions.map(({ dir }) => dir)).toEqual(['/slow-recovery'])
  })

  it('does not replace an isolated live root after its resubscription times out', async () => {
    pool = new RuntimeWatcherProcessPool({
      maxSharedSupervisors: 1,
      createSupervisor: () => {
        const supervisor = new FakeSupervisor()
        supervisors.push(supervisor)
        return supervisor
      }
    })
    const fused = new WatcherProcessFailure(
      'file watcher process crashed repeatedly',
      'supervisor',
      'supervisor_crash_fuse'
    )
    const timeout = new WatcherProcessFailure(
      'file watcher resubscription timed out',
      'subscription',
      'subscribe_timeout'
    )
    await pool.subscribe('/slow-recovery', vi.fn(), {}, {})
    supervisors[0].subscriptions[0].hooks.onTerminalError?.(fused)
    await pool.subscribe('/slow-recovery', vi.fn(), {}, {})

    supervisors[1].subscriptions[0].hooks.onTerminalError?.(timeout)

    await expect(pool.subscribe('/slow-recovery', vi.fn(), {}, {})).rejects.toMatchObject({
      code: 'supervisor_crash_fuse'
    })
    expect(supervisors).toHaveLength(2)
  })

  it('keeps healthy shard assignments after a root-specific failure', async () => {
    pool = new RuntimeWatcherProcessPool({
      maxSharedSupervisors: 1,
      createSupervisor: () => {
        const supervisor = new FakeSupervisor()
        supervisors.push(supervisor)
        return supervisor
      }
    })
    await pool.subscribe('/healthy', vi.fn(), {}, {})
    const onTerminalError = vi.fn()
    await pool.subscribe('/gone', vi.fn(), {}, { onTerminalError })
    const shared = supervisors[0]
    const failed = shared.subscriptions.find(({ dir }) => dir === '/gone')
    const failure = new WatcherProcessFailure(
      'root unavailable',
      'subscription',
      'subscribe_failed'
    )

    failed?.hooks.onTerminalError?.(failure)
    await pool.subscribe('/gone', vi.fn(), {}, {})

    expect(onTerminalError).toHaveBeenCalledWith(failure)
    expect(supervisors).toHaveLength(1)
    expect(shared.subscriptions.map(({ dir }) => dir)).toEqual(['/healthy', '/gone', '/gone'])
    expect(shared.dispose).not.toHaveBeenCalled()
  })

  it('stops replacing a root after its bounded quarantine shard also fuses', async () => {
    pool = new RuntimeWatcherProcessPool({
      maxSharedSupervisors: 1,
      createSupervisor: () => {
        const supervisor = new FakeSupervisor()
        supervisors.push(supervisor)
        return supervisor
      }
    })
    const failure = new WatcherProcessFailure(
      'file watcher process crashed repeatedly',
      'supervisor',
      'supervisor_crash_fuse'
    )
    await pool.subscribe('/unstable', vi.fn(), {}, {})
    supervisors[0].subscriptions[0].hooks.onTerminalError?.(failure)
    await pool.subscribe('/unstable', vi.fn(), {}, {})
    supervisors[1].subscriptions[0].hooks.onTerminalError?.(failure)

    await expect(pool.subscribe('/unstable', vi.fn(), {}, {})).rejects.toThrow(
      'failed again in quarantine'
    )
    expect(supervisors).toHaveLength(2)
  })

  it('clears fused quarantine history when forgetRoot runs without an assignment', async () => {
    pool = new RuntimeWatcherProcessPool({
      maxSharedSupervisors: 1,
      createSupervisor: () => {
        const supervisor = new FakeSupervisor()
        supervisors.push(supervisor)
        return supervisor
      }
    })
    const failure = new WatcherProcessFailure(
      'file watcher process crashed repeatedly',
      'supervisor',
      'supervisor_crash_fuse'
    )
    await pool.subscribe('/unstable', vi.fn(), {}, {})
    supervisors[0].subscriptions[0].hooks.onTerminalError?.(failure)
    await pool.subscribe('/unstable', vi.fn(), {}, {})
    supervisors[1].subscriptions[0].hooks.onTerminalError?.(failure)

    await expect(pool.subscribe('/unstable', vi.fn(), {}, {})).rejects.toThrow(
      'failed again in quarantine'
    )

    pool.forgetRoot('/unstable')

    await expect(pool.subscribe('/unstable', vi.fn(), {}, {})).resolves.toBeDefined()
    expect(supervisors).toHaveLength(3)
  })

  it('disposes every supervisor and clears isolation on reset', async () => {
    await pool.subscribe('/a', vi.fn(), {}, {})
    await pool.subscribe('/b', vi.fn(), {}, {})

    pool.resetForTest()

    expect(supervisors.every((supervisor) => supervisor.dispose.mock.calls.length === 1)).toBe(true)
    await expect(pool.subscribe('/after-reset', vi.fn(), {}, {})).resolves.toBeDefined()
    expect(supervisors).toHaveLength(2)
  })
})
