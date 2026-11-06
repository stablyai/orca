import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WatcherCanaryActivity } from './parcel-watcher-delivery-canary'

const { subscribeMock, watchMock, writeFileSyncMock } = vi.hoisted(() => ({
  subscribeMock: vi.fn(),
  watchMock: vi.fn(),
  writeFileSyncMock: vi.fn()
}))

vi.mock('node:fs', () => ({
  mkdtempSync: vi.fn(() => '/tmp/orca-watcher-canary-test'),
  rmSync: vi.fn(),
  watch: watchMock,
  writeFileSync: writeFileSyncMock
}))
vi.mock('@parcel/watcher', () => ({ subscribe: subscribeMock }))

type Delivery = { native: boolean; independent: boolean }

describe('watcher delivery canary', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
  let originalExitListeners: NodeJS.ExitListener[]
  let delivery: Delivery
  let activity: WatcherCanaryActivity
  let canaryWrites: number[]
  let health: string[]
  let stderr: string[]
  let exitSpy: ReturnType<typeof vi.spyOn>
  let onProbeWrite: () => void

  const setPlatform = (platform: NodeJS.Platform): void => {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  }

  const start = async (overrides: Partial<WatcherCanaryActivity> = {}): Promise<void> => {
    activity = {
      revision: 1,
      liveSubscriptions: 1,
      pendingCrawlStartedAt: null,
      lastNativeCallbackAt: 0,
      ...overrides
    }
    const { startWatcherDeliveryCanary } = await import('./parcel-watcher-delivery-canary')
    await startWatcherDeliveryCanary(
      () => activity,
      (state) => health.push(state)
    )
  }

  /** One healthy check proves fs.watch delivers in this process, then delivery stops. */
  const startHealthyThenStall = async (): Promise<void> => {
    delivery = { native: true, independent: true }
    await start()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(health).toEqual(['healthy'])
    delivery = { native: false, independent: false }
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    vi.resetModules()
    setPlatform('linux')
    originalExitListeners = process.listeners('exit')
    delivery = { native: false, independent: false }
    canaryWrites = []
    health = []
    stderr = []
    onProbeWrite = () => undefined
    let nativeCallback: ((err: Error | null) => void) | undefined
    let independentListener: (() => void) | undefined
    subscribeMock.mockReset().mockImplementation(async (_dir, callback) => {
      nativeCallback = callback
      return { unsubscribe: vi.fn() }
    })
    watchMock.mockReset().mockImplementation((_dir, _opts, listener: () => void) => {
      independentListener = listener
      return Object.assign(new EventEmitter(), {
        close: () => {
          independentListener = undefined
        }
      })
    })
    writeFileSyncMock.mockReset().mockImplementation((path: string) => {
      if (path.endsWith('canary.txt')) {
        canaryWrites.push(Date.now())
      } else {
        onProbeWrite()
      }
      if (delivery.native) {
        nativeCallback?.(null)
      }
      if (delivery.independent) {
        independentListener?.()
      }
    })
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk))
      return true
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub must return so the canary's post-exit path is observable; it is never used as a real exit.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
  })

  afterEach(() => {
    for (const listener of process.listeners('exit')) {
      if (!originalExitListeners.includes(listener)) {
        process.off('exit', listener)
      }
    }
    Object.defineProperty(process, 'platform', originalPlatform)
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('keeps the child, backs off and reports the stall when the system event source stalls', async () => {
    await startHealthyThenStall()

    await vi.advanceTimersByTimeAsync(300_000)

    expect(exitSpy).not.toHaveBeenCalled()
    expect(stderr.join('')).toContain('system file events stalled')
    expect(health).toEqual(['healthy', 'stalled'])
    // Healthy at 10 s; misses at 20 s and 30 s; then each silent probe doubles the wait.
    expect(canaryWrites).toEqual([10_000, 20_000, 30_000, 70_000, 140_000, 270_000])

    delivery.native = true
    await vi.advanceTimersByTimeAsync(270_000)

    expect(exitSpy).not.toHaveBeenCalled()
    expect(stderr.join('')).toContain('system file events recovered')
    expect(health).toEqual(['healthy', 'stalled', 'healthy'])
  })

  it('reports the stall over when the canary disarms, and re-detects it once re-armed', async () => {
    await startHealthyThenStall()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(health).toEqual(['healthy', 'stalled'])

    activity.liveSubscriptions = 0
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(health).toEqual(['healthy', 'stalled', 'unknown'])

    activity.liveSubscriptions = 1
    await vi.advanceTimersByTimeAsync(60_000)
    expect(health).toEqual(['healthy', 'stalled', 'unknown', 'stalled'])
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('keeps one fs.watch for the life of the child instead of one per probe', async () => {
    await startHealthyThenStall()

    await vi.advanceTimersByTimeAsync(600_000)

    expect(health).toContain('stalled')
    expect(watchMock).toHaveBeenCalledOnce()
  })

  it('restarts when fs.watch still delivers but the native canary is starved', async () => {
    delivery.independent = true
    await start()

    await vi.advanceTimersByTimeAsync(30_000)

    expect(exitSpy).toHaveBeenCalledWith(2)
    expect(stderr.join('')).toContain('canary starved while fs.watch delivered')
  })

  it('restarts when fs.watch has never delivered in this process', async () => {
    await start()

    await vi.advanceTimersByTimeAsync(30_000)

    expect(exitSpy).toHaveBeenCalledWith(2)
    expect(stderr.join('')).toContain('fs.watch never delivered in this process')
  })

  it('accepts fs.watch proof from any later delivery, not a one-shot startup check', async () => {
    // fs.watch is silent through startup, then delivers once during a healthy check.
    delivery = { native: true, independent: false }
    await start()
    await vi.advanceTimersByTimeAsync(15_000)
    delivery.independent = true
    await vi.advanceTimersByTimeAsync(10_000)
    delivery = { native: false, independent: false }

    await vi.advanceTimersByTimeAsync(120_000)

    expect(exitSpy).not.toHaveBeenCalled()
    expect(health).toEqual(['healthy', 'stalled'])
  })

  it('does not restart while another native subscription keeps delivering', async () => {
    delivery.independent = true
    onProbeWrite = () => {
      activity.lastNativeCallbackAt = Date.now()
    }
    await start()

    await vi.advanceTimersByTimeAsync(120_000)

    expect(exitSpy).not.toHaveBeenCalled()
    expect(stderr.join('')).not.toContain('stalled')
  })

  it('bounds a stall that never recovers with a restart', async () => {
    await startHealthyThenStall()

    await vi.advanceTimersByTimeAsync(13 * 60_000)
    expect(exitSpy).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(7 * 60_000)
    expect(exitSpy).toHaveBeenCalledWith(2)
    expect(stderr.join('')).toContain('system file events stalled for')
  })

  it('does not restart when the native canary answers the independent probe', async () => {
    await start()
    await vi.advanceTimersByTimeAsync(25_000)
    delivery.native = true

    await vi.advanceTimersByTimeAsync(60_000)

    expect(exitSpy).not.toHaveBeenCalled()
    expect(stderr.join('')).not.toContain('stalled')
  })

  it('detects a deadlocked pending subscribe on macOS', async () => {
    setPlatform('darwin')
    delivery.independent = true
    await start({ liveSubscriptions: 0, pendingCrawlStartedAt: 0 })

    await vi.advanceTimersByTimeAsync(30_000)

    expect(exitSpy).toHaveBeenCalledWith(2)
  })

  it.each(['linux', 'win32'] as const)(
    'stays disarmed for a crawl of any length on %s',
    async (platform) => {
      setPlatform(platform)
      delivery.independent = true
      await start({ pendingCrawlStartedAt: 0 })

      await vi.advanceTimersByTimeAsync(60 * 60_000)

      expect(canaryWrites).toEqual([])
      expect(exitSpy).not.toHaveBeenCalled()
    }
  )
})

describe('armedCanaryRevision', () => {
  const idle = {
    revision: 4,
    liveSubscriptions: 0,
    pendingCrawlStartedAt: null,
    lastNativeCallbackAt: 0
  }

  it('arms for live subscriptions and disarms when idle', async () => {
    const { armedCanaryRevision } = await import('./parcel-watcher-delivery-canary')
    expect(armedCanaryRevision(idle, 'linux')).toBeNull()
    expect(armedCanaryRevision({ ...idle, liveSubscriptions: 2 }, 'win32')).toBe(4)
  })

  it('arms during a pending subscribe only on macOS', async () => {
    const { armedCanaryRevision } = await import('./parcel-watcher-delivery-canary')
    const pending = { ...idle, revision: 7, liveSubscriptions: 1, pendingCrawlStartedAt: 1_000 }
    expect(armedCanaryRevision(pending, 'darwin')).toBe(7)
    expect(armedCanaryRevision(pending, 'linux')).toBeNull()
    expect(armedCanaryRevision(pending, 'win32')).toBeNull()
  })
})
