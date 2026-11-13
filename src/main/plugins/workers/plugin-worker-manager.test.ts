import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginWorkerHandle } from './parent-process/plugin-host-process-types'
import { PluginWorkerManager } from './plugin-worker-manager'
import type {
  PluginWorkerFactory,
  PluginWorkerSpawnSpec
} from './worker-supervision/plugin-worker-startup'

type TestWorker = PluginWorkerHandle & {
  exit(code?: number | null): void
  dispose: ReturnType<typeof vi.fn<() => Promise<void>>>
}

function worker(lastActivity = 1_000): TestWorker {
  const exitCallbacks: ((code: number | null) => void)[] = []
  return {
    commands: ['run'],
    invokeCommand: vi.fn(async () => null),
    taskSources: [],
    invokeTaskSource: vi.fn(async () => null),
    deliverEvent: vi.fn(),
    requestFromPanel: vi.fn(),
    runHook: vi.fn(),
    notifyDataChanged: vi.fn(),
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
    log: () => vi.fn(),
    onWorkerStateChange: vi.fn()
  })
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('PluginWorkerManager capacity', () => {
  it('cancels an in-flight start without allowing its generation to land', async () => {
    let finishStart!: (handle: PluginWorkerHandle) => void
    const pendingStart = new Promise<PluginWorkerHandle>((resolve) => {
      finishStart = resolve
    })
    const factory = vi.fn<PluginWorkerFactory>(() => pendingStart)
    const subject = manager(factory)
    const lateWorker = worker()
    const activation = subject.ensureActive(spec('starting'))
    await flush()

    try {
      const deactivation = subject.deactivate('starting')
      finishStart(lateWorker)
      await deactivation

      await expect(activation).rejects.toThrow('cancelled')
      expect(lateWorker.dispose).toHaveBeenCalledOnce()
      expect(subject.runState('starting')).toBe('inactive')
      expect(subject.trackedSpecs().has('starting')).toBe(false)
    } finally {
      finishStart(lateWorker)
      await subject.disposeAll()
    }
  })
})

describe('PluginWorkerManager idle reap', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not count time the machine slept as idle time', async () => {
    const minute = 60_000
    const busy = worker(2 * minute)
    const subject = manager(vi.fn<PluginWorkerFactory>().mockResolvedValue(busy), {
      idleReapMs: 5 * minute
    })
    await subject.ensureActive(spec('demo'))
    subject.reapIdle(2 * minute)
    subject.reapIdle(3 * minute)

    // Lid closed for an hour: the next sweep is the first one after wake.
    subject.reapIdle(63 * minute)
    await flush()

    expect(busy.dispose).not.toHaveBeenCalled()
    expect(subject.runState('demo')).toBe('running')
    await subject.disposeAll()
  })

  it('does not count a sleep before the first sweep as idle time', async () => {
    const minute = 60_000
    vi.useFakeTimers({ now: 0 })
    const busy = worker(0)
    const subject = manager(vi.fn<PluginWorkerFactory>().mockResolvedValue(busy), {
      idleReapMs: 5 * minute
    })
    await subject.ensureActive(spec('demo'))

    // Lid closed before the reaper's first sweep, opened an hour later.
    subject.reapIdle(60 * minute)
    await flush()

    expect(busy.dispose).not.toHaveBeenCalled()
    expect(subject.runState('demo')).toBe('running')
    await subject.disposeAll()
  })

  it('still reaps a worker that stays idle for a full window after waking', async () => {
    const minute = 60_000
    const idle = worker(2 * minute)
    const subject = manager(vi.fn<PluginWorkerFactory>().mockResolvedValue(idle), {
      idleReapMs: 5 * minute
    })
    await subject.ensureActive(spec('demo'))
    subject.reapIdle(3 * minute)
    subject.reapIdle(63 * minute)
    for (let at = 64; at <= 69; at++) {
      subject.reapIdle(at * minute)
    }
    await flush()

    expect(idle.dispose).toHaveBeenCalledOnce()
    expect(subject.runState('demo')).toBe('inactive')
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
