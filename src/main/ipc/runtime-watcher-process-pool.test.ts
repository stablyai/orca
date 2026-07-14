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
      maxSharedSupervisors: 4,
      createSupervisor: () => {
        const supervisor = new FakeSupervisor()
        supervisors.push(supervisor)
        return supervisor
      }
    })
  })

  it('spreads roots across a bounded healthy pool before sharing children', async () => {
    for (const dir of ['/a', '/b', '/c', '/d', '/e']) {
      await pool.subscribe(dir, vi.fn(), {}, {})
    }

    expect(supervisors).toHaveLength(4)
    expect(supervisors.map((supervisor) => supervisor.subscriptions.map(({ dir }) => dir))).toEqual(
      [['/a', '/e'], ['/b'], ['/c'], ['/d']]
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

  it('bounds quarantine supervisors when a fused shard contains many roots', async () => {
    pool = new RuntimeWatcherProcessPool({
      maxSharedSupervisors: 1,
      createSupervisor: () => {
        const supervisor = new FakeSupervisor()
        supervisors.push(supervisor)
        return supervisor
      }
    })
    const roots = Array.from({ length: 12 }, (_, index) => `/root-${index}`)
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
    for (const root of roots) {
      await pool.subscribe(root, vi.fn(), {}, {})
    }

    expect(supervisors).toHaveLength(5)
    expect(supervisors.slice(1).map(({ subscriptions }) => subscriptions.length)).toEqual([
      3, 3, 3, 3
    ])
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
  })
})
