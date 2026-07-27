import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginWorkerHandle } from './plugin-host-process'
import {
  PluginWorkerManager,
  type PluginWorkerFactory,
  type PluginWorkerSpawnSpec
} from './plugin-worker-manager'

type TestWorker = PluginWorkerHandle & {
  exit(code?: number | null): void
  dispose: ReturnType<typeof vi.fn<() => Promise<void>>>
}

function worker(lastActivity = Date.now()): TestWorker {
  const exitCallbacks: ((code: number | null) => void)[] = []
  return {
    commands: ['run'],
    invokeCommand: vi.fn(async () => null),
    deliverEvent: vi.fn(),
    lastActivityAt: () => lastActivity,
    inFlightCount: () => 0,
    dispose: vi.fn(async () => undefined),
    kill: vi.fn(),
    onExit: (callback) => exitCallbacks.push(callback),
    exit: (code = 1) => {
      for (const callback of exitCallbacks) {
        callback(code)
      }
    }
  }
}

function spec(pluginKey: string): PluginWorkerSpawnSpec {
  return {
    pluginKey,
    rootDir: `/plugins/${pluginKey}`,
    mainEntry: 'worker.js',
    grantedCapabilities: []
  }
}

function manager(
  factory: PluginWorkerFactory,
  options: { maxActive?: number; idleReapMs?: number } = {}
): PluginWorkerManager {
  return new PluginWorkerManager({
    entryPath: '/host.js',
    workerFactory: factory,
    maxActive: options.maxActive,
    idleReapMs: options.idleReapMs,
    executeHostCall: async () => ({ ok: true, value: null }),
    log: vi.fn(),
    onWorkerStateChange: vi.fn(),
    onWorkerGone: vi.fn()
  })
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
})

describe('PluginWorkerManager capacity', () => {
  it('atomically counts in-flight starts against maxActive', async () => {
    const starts: { key: string; resolve: (handle: TestWorker) => void }[] = []
    const factory = vi.fn<PluginWorkerFactory>(
      ({ pluginId }) => new Promise((resolve) => starts.push({ key: pluginId, resolve }))
    )
    const subject = manager(factory, { maxActive: 1 })

    const first = subject.ensureActive(spec('one'))
    const second = subject.ensureActive(spec('two'))
    const third = subject.ensureActive(spec('three'))
    await flush()

    expect(starts.map((start) => start.key)).toEqual(['one'])
    starts[0]!.resolve(worker())
    await first
    await subject.deactivate('one')
    await flush()
    expect(starts.map((start) => start.key)).toEqual(['one', 'two'])

    starts[1]!.resolve(worker())
    await second
    await subject.deactivate('two')
    await flush()
    expect(starts.map((start) => start.key)).toEqual(['one', 'two', 'three'])
    starts[2]!.resolve(worker())
    await third
    await subject.disposeAll()
  })

  it('removes a cancelled waiter without disturbing FIFO order', async () => {
    const starts: { key: string; resolve: (handle: TestWorker) => void }[] = []
    const factory = vi.fn<PluginWorkerFactory>(
      ({ pluginId }) => new Promise((resolve) => starts.push({ key: pluginId, resolve }))
    )
    const subject = manager(factory, { maxActive: 1 })
    const first = subject.ensureActive(spec('one'))
    const cancelled = subject.ensureActive(spec('two'))
    const third = subject.ensureActive(spec('three'))
    await flush()
    starts[0]!.resolve(worker())
    await first

    await subject.deactivate('two')
    await expect(cancelled).rejects.toThrow('cancelled')
    await subject.deactivate('one')
    await flush()

    expect(starts.map((start) => start.key)).toEqual(['one', 'three'])
    starts[1]!.resolve(worker())
    await third
    await subject.disposeAll()
  })

  it('releases a failed start so the next FIFO waiter can run', async () => {
    vi.useFakeTimers()
    const secondWorker = worker()
    const factory = vi.fn<PluginWorkerFactory>(async ({ pluginId }) => {
      if (pluginId === 'one') {
        throw new Error('ready failed')
      }
      return secondWorker
    })
    const subject = manager(factory, { maxActive: 1 })
    const first = subject.ensureActive(spec('one'))
    const firstSettled = first.catch(() => undefined)
    const second = subject.ensureActive(spec('two'))

    await flush()
    await expect(second).resolves.toBe(secondWorker)
    expect(factory.mock.calls.map(([options]) => options.pluginId)).toEqual(['one', 'two'])
    await subject.deactivate('one')
    await firstSettled
    await subject.disposeAll()
  })

  it('cancels an in-flight start without allowing its generation to land', async () => {
    const factory = vi.fn<PluginWorkerFactory>(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('factory cancelled')), {
            once: true
          })
        })
    )
    const subject = manager(factory)
    const activation = subject.ensureActive(spec('starting'))
    await flush()

    await subject.deactivate('starting')

    await expect(activation).rejects.toThrow('cancelled')
    expect(subject.runState('starting')).toBe('inactive')
    expect(subject.trackedSpecs().has('starting')).toBe(false)
    await subject.disposeAll()
  })

  it('disposes running workers and rejects queued waiters', async () => {
    const first = worker()
    const factory = vi.fn<PluginWorkerFactory>(async ({ pluginId }) => {
      if (pluginId === 'one') {
        return first
      }
      return new Promise<PluginWorkerHandle>(() => undefined)
    })
    const subject = manager(factory, { maxActive: 1 })
    await subject.ensureActive(spec('one'))
    const queued = subject.ensureActive(spec('two'))
    const queuedSettled = queued.catch((error) => error)
    await flush()

    await subject.disposeAll()

    expect(first.dispose).toHaveBeenCalledOnce()
    await expect(queuedSettled).resolves.toBeInstanceOf(Error)
    expect(factory).toHaveBeenCalledTimes(1)
  })
})

describe('PluginWorkerManager restart policy', () => {
  it('cancels a stale in-flight revision instead of joining it by plugin key', async () => {
    const currentWorker = worker()
    const factory = vi.fn<PluginWorkerFactory>(({ rootDir, signal }) => {
      if (rootDir === '/plugins/old') {
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('old revision cancelled')), {
            once: true
          })
        })
      }
      return Promise.resolve(currentWorker)
    })
    const subject = manager(factory)
    const oldSpec = { ...spec('demo'), rootDir: '/plugins/old', manifestRevision: 'old' }
    const newSpec = { ...spec('demo'), rootDir: '/plugins/new', manifestRevision: 'new' }

    const oldActivation = subject.ensureActive(oldSpec)
    await flush()
    const currentActivation = subject.ensureActive(newSpec)

    await expect(oldActivation).rejects.toThrow('cancelled')
    await expect(currentActivation).resolves.toBe(currentWorker)
    expect(factory.mock.calls.map(([options]) => options.rootDir)).toEqual([
      '/plugins/old',
      '/plugins/new'
    ])
    await subject.disposeAll()
  })

  it('retries startup failures at 500/2000/5000ms before errored', async () => {
    vi.useFakeTimers()
    const factory = vi.fn<PluginWorkerFactory>(async () => {
      throw new Error('not ready')
    })
    const subject = manager(factory)
    const activation = subject.ensureActive(spec('demo'))
    let failure: unknown
    const settled = activation.catch((error) => {
      failure = error
    })

    await flush()
    expect(factory).toHaveBeenCalledTimes(1)
    expect(subject.restartCount('demo')).toBe(1)
    expect(subject.runState('demo')).toBe('restarting')
    await vi.advanceTimersByTimeAsync(499)
    expect(factory).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(factory).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(factory).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(5_000)
    await settled

    expect(factory).toHaveBeenCalledTimes(4)
    expect(subject.runState('demo')).toBe('errored')
    expect(failure).toBeInstanceOf(Error)
    await subject.disposeAll()
  })

  it('joins triggers during backoff without resetting restart history', async () => {
    vi.useFakeTimers()
    const ready = worker()
    const factory = vi.fn<PluginWorkerFactory>(async () => {
      if (factory.mock.calls.length === 1) {
        throw new Error('first start failed')
      }
      return ready
    })
    const subject = manager(factory)
    const first = subject.ensureActive(spec('demo'))
    await flush()
    const joined = subject.ensureActive(spec('demo'))

    expect(subject.restartCount('demo')).toBe(1)
    expect(factory).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(500)

    await expect(Promise.all([first, joined])).resolves.toEqual([ready, ready])
    expect(factory).toHaveBeenCalledTimes(2)
    expect(subject.restartCount('demo')).toBe(1)
    await subject.disposeAll()
  })

  it('applies the same backoff history to unexpected post-ready exits', async () => {
    vi.useFakeTimers()
    const workers = [worker(), worker(), worker(), worker()]
    const factory = vi.fn<PluginWorkerFactory>(async () => workers[factory.mock.calls.length - 1]!)
    const subject = manager(factory)

    await subject.ensureActive(spec('demo'))
    workers[0]!.exit(11)
    expect(subject.runState('demo')).toBe('restarting')
    await vi.advanceTimersByTimeAsync(500)
    expect(factory).toHaveBeenCalledTimes(2)
    workers[1]!.exit(12)
    expect(subject.runState('demo')).toBe('restarting')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(factory).toHaveBeenCalledTimes(3)
    workers[2]!.exit(13)
    expect(subject.runState('demo')).toBe('restarting')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(factory).toHaveBeenCalledTimes(4)
    workers[3]!.exit(14)

    expect(subject.runState('demo')).toBe('errored')
    expect(subject.restartCount('demo')).toBe(3)
    await subject.disposeAll()
  })

  it('cancels a pending restart and never resurrects after deactivate', async () => {
    vi.useFakeTimers()
    const first = worker()
    const factory = vi.fn<PluginWorkerFactory>(async () => first)
    const subject = manager(factory)
    await subject.ensureActive(spec('demo'))
    first.exit()
    expect(subject.restartCount('demo')).toBe(1)

    await subject.deactivate('demo')
    await vi.advanceTimersByTimeAsync(10_000)

    expect(factory).toHaveBeenCalledTimes(1)
    expect(subject.runState('demo')).toBe('inactive')
    await subject.disposeAll()
  })
})

describe('PluginWorkerManager idle reap', () => {
  it('does not reap a worker while an event handler is still in flight', async () => {
    const busy = worker(100)
    busy.inFlightCount = () => 1
    const subject = manager(vi.fn<PluginWorkerFactory>().mockResolvedValue(busy), {
      idleReapMs: 100
    })
    await subject.ensureActive(spec('demo'))

    subject.reapIdle(10_000)

    expect(busy.dispose).not.toHaveBeenCalled()
    expect(subject.runState('demo')).toBe('running')
    await subject.disposeAll()
  })

  it('disposes an idle worker and activates a fresh generation on demand', async () => {
    const first = worker(100)
    const second = worker(1_000)
    const factory = vi
      .fn<PluginWorkerFactory>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
    const subject = manager(factory, { idleReapMs: 100 })
    await subject.ensureActive(spec('demo'))

    subject.reapIdle(201)
    await flush()
    expect(first.dispose).toHaveBeenCalledOnce()
    expect(subject.runState('demo')).toBe('inactive')
    await expect(subject.ensureActive(spec('demo'))).resolves.toBe(second)
    await subject.disposeAll()
  })

  it('waits for an in-progress idle shutdown during manager disposal', async () => {
    let finishShutdown!: () => void
    const idle = worker(100)
    idle.dispose.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishShutdown = resolve
        })
    )
    const subject = manager(vi.fn<PluginWorkerFactory>().mockResolvedValue(idle), {
      idleReapMs: 100
    })
    await subject.ensureActive(spec('demo'))
    subject.reapIdle(201)
    let disposed = false
    const disposal = subject.disposeAll().then(() => {
      disposed = true
    })
    await flush()
    expect(disposed).toBe(false)

    finishShutdown()
    await disposal
    expect(disposed).toBe(true)
  })
})
