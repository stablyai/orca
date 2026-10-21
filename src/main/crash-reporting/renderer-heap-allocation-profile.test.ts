import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  noteRendererHeapReading,
  profileRendererMemoryBreadcrumb,
  resetRendererHeapAllocationProfilesForTests,
  type ProfiledRenderer,
  type RendererHeapReading
} from './renderer-heap-allocation-profile'
import { clearCrashBreadcrumbsForTest, getCrashBreadcrumbSnapshot } from './crash-breadcrumb-store'

const PAGE = 'file:///Users/someone/Orca.app/Contents/Resources/app.asar/out/renderer/index.html'
const BUNDLE = 'file:///Users/someone/Orca.app/Contents/Resources/app.asar/out/renderer/assets/'

const profile = {
  head: {
    callFrame: { functionName: '(root)', url: '', scriptId: '0', lineNumber: -1, columnNumber: -1 },
    selfSize: 0,
    children: [
      {
        callFrame: {
          functionName: 'sliceOutput',
          url: `${BUNDLE}terminal-Ab12.js`,
          scriptId: '7',
          lineNumber: 20,
          columnNumber: 4
        },
        selfSize: 3 * 1024 * 1024
      }
    ]
  }
}

function fakeRenderer(id: number, { attached = false, holdStart = false } = {}) {
  const documentEndWatchers = new Set<() => void>()
  let isAttached = attached
  let releaseStart = (): void => undefined
  const started = holdStart
    ? new Promise<void>((resolve) => {
        releaseStart = resolve
      })
    : Promise.resolve()
  const sendCommand = vi.fn(async (method: string) => {
    if (method === 'HeapProfiler.startSampling') {
      await started
    }
    return method === 'HeapProfiler.getSamplingProfile' ? { profile } : {}
  })
  const detachListeners = new Set<() => void>()
  const renderer: ProfiledRenderer = {
    id,
    isDestroyed: () => false,
    getURL: () => PAGE,
    watchDocumentEnd: (onEnd) => {
      documentEndWatchers.add(onEnd)
      return () => documentEndWatchers.delete(onEnd)
    },
    debugger: {
      isAttached: () => isAttached,
      attach: vi.fn(() => {
        isAttached = true
      }),
      detach: vi.fn(() => {
        isAttached = false
        detachListeners.forEach((listener) => listener())
      }),
      sendCommand,
      on: (_event, listener) => detachListeners.add(listener),
      removeListener: (_event, listener) => detachListeners.delete(listener)
    }
  }
  return {
    renderer,
    sendCommand,
    releaseStart: () => releaseStart(),
    endDocument: () => [...documentEndWatchers].forEach((onEnd) => onEnd()),
    watcherCount: () => documentEndWatchers.size,
    reads: () =>
      sendCommand.mock.calls.filter(([method]) => method === 'HeapProfiler.getSamplingProfile')
        .length
  }
}

const sample = (heapRatio: number): RendererHeapReading => ({
  heapRatio,
  rendererSurface: 'main',
  isHighwaterMark: false
})
const mark = (heapRatio: number): RendererHeapReading => ({
  heapRatio,
  rendererSurface: 'main',
  isHighwaterMark: true
})
const sampling = (sendCommand: ReturnType<typeof fakeRenderer>['sendCommand']) =>
  vi.waitFor(() =>
    expect(sendCommand).toHaveBeenCalledWith('HeapProfiler.startSampling', {
      samplingInterval: 512 * 1024
    })
  )

afterEach(() => {
  vi.useRealTimers()
  resetRendererHeapAllocationProfilesForTests()
  clearCrashBreadcrumbsForTest()
})

describe('noteRendererHeapReading', () => {
  it('starts at 60% and refreshes every 30 seconds and on later marks', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    const fake = fakeRenderer(1)
    const record = vi.fn()

    noteRendererHeapReading(fake.renderer, sample(0.59), record)
    expect(fake.renderer.debugger.attach).not.toHaveBeenCalled()
    noteRendererHeapReading(fake.renderer, sample(0.61), record)
    await sampling(fake.sendCommand)

    noteRendererHeapReading(fake.renderer, sample(0.62), record)
    expect(fake.reads()).toBe(0)
    vi.advanceTimersByTime(30_000)
    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(1))
    expect(record.mock.calls[0][0]).toMatchObject({
      rendererSurface: 'main',
      startedAtPct: 61,
      sampledMinutes: 1,
      site01: '3072KB sliceOutput@terminal-Ab12.js:21:5'
    })

    noteRendererHeapReading(fake.renderer, mark(0.81), record)
    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(2))
    expect(fake.renderer.debugger.attach).toHaveBeenCalledTimes(1)
  })

  it('reads soon after a slow start even when both marks arrived during it', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const fake = fakeRenderer(2, { holdStart: true })
    const record = vi.fn()

    noteRendererHeapReading(fake.renderer, sample(0.85), record)
    noteRendererHeapReading(fake.renderer, mark(0.85), record)
    noteRendererHeapReading(fake.renderer, mark(0.85), record)
    expect(fake.reads()).toBe(0)

    fake.releaseStart()
    await sampling(fake.sendCommand)
    await vi.waitFor(() => {
      vi.advanceTimersByTime(30_000)
      expect(record).toHaveBeenCalledTimes(1)
    })
  })

  it('releases the debugger once the heap falls below 50%, and starts again at 60%', async () => {
    const fake = fakeRenderer(3)
    noteRendererHeapReading(fake.renderer, sample(0.7), vi.fn())
    await sampling(fake.sendCommand)

    noteRendererHeapReading(fake.renderer, sample(0.55), vi.fn())
    expect(fake.renderer.debugger.detach).not.toHaveBeenCalled()
    noteRendererHeapReading(fake.renderer, sample(0.45), vi.fn())
    expect(fake.renderer.debugger.detach).toHaveBeenCalledTimes(1)
    expect(fake.sendCommand).toHaveBeenCalledWith('HeapProfiler.stopSampling')
    expect(fake.watcherCount()).toBe(0)

    noteRendererHeapReading(fake.renderer, sample(0.6), vi.fn())
    expect(fake.renderer.debugger.attach).toHaveBeenCalledTimes(2)
  })

  it('stops when the window loads a new document or goes away, leaving no listeners', async () => {
    const fake = fakeRenderer(4)
    for (let cycle = 0; cycle < 3; cycle++) {
      noteRendererHeapReading(fake.renderer, sample(0.7), vi.fn())
      await sampling(fake.sendCommand)
      fake.endDocument()
    }

    expect(fake.renderer.debugger.detach).toHaveBeenCalledTimes(3)
    expect(fake.watcherCount()).toBe(0)
  })

  it('never takes over a debugger someone else attached', () => {
    const fake = fakeRenderer(5, { attached: true })

    noteRendererHeapReading(fake.renderer, mark(0.9), vi.fn())

    expect(fake.renderer.debugger.attach).not.toHaveBeenCalled()
    expect(fake.sendCommand).not.toHaveBeenCalled()
  })
})

describe('profileRendererMemoryBreadcrumb', () => {
  it('reads heap use from memory crumbs and records a retained crumb for the sender', async () => {
    const fake = fakeRenderer(6)
    const origin = 'renderer:6'
    const crumb = (name: string, usedHeapMB: number, extra: Record<string, unknown> = {}) =>
      profileRendererMemoryBreadcrumb(
        fake.renderer,
        { name, data: { usedHeapMB, heapLimitMB: 4000, ...extra } },
        origin
      )

    crumb('renderer_memory_highwater', 900, { rendererSurface: 'main', thresholdPrivateMB: 600 })
    crumb('renderer_click', 3900)
    expect(fake.renderer.debugger.attach).not.toHaveBeenCalled()

    crumb('renderer_memory', 2500, { rendererSurface: 'main' })
    crumb('renderer_memory_highwater', 2500, { rendererSurface: 'main', thresholdPct: 60 })
    await sampling(fake.sendCommand)
    await vi.waitFor(() => {
      crumb('renderer_memory_highwater', 3300, { rendererSurface: 'main', thresholdPct: 80 })
      expect(getCrashBreadcrumbSnapshot().map((entry) => entry.name)).toContain(
        'renderer_heap_allocation_profile'
      )
    })
    const recorded = getCrashBreadcrumbSnapshot().find(
      (entry) => entry.name === 'renderer_heap_allocation_profile'
    )
    expect(recorded?.origin).toBe(origin)
    expect(recorded?.data).toMatchObject({ rendererSurface: 'main', startedAtPct: 63 })
  })
})
