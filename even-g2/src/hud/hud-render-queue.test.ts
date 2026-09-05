import { describe, expect, it, vi } from 'vitest'
import { HudRenderQueue } from './hud-render-queue'
import { buildHudPage } from './hud-page-spec'
import type { GlassesBridge, StartupBuildResult } from '../glasses/glasses-bridge'

function createMockBridge(): GlassesBridge & {
  createStartUpPage: ReturnType<typeof vi.fn>
  rebuildPage: ReturnType<typeof vi.fn>
  upgradeText: ReturnType<typeof vi.fn>
} {
  return {
    createStartUpPage: vi.fn(async () => 'success' as StartupBuildResult),
    rebuildPage: vi.fn(async () => true),
    upgradeText: vi.fn(async () => true),
    shutDownPage: vi.fn(async () => true),
    getDeviceSnapshot: vi.fn(async () => null),
    setStoredValue: vi.fn(async () => true),
    getStoredValue: vi.fn(async () => ''),
    onRawEvent: vi.fn(() => () => {}),
    onDeviceStatusChanged: vi.fn(() => () => {})
  }
}

/** Flush pending microtasks so async chains inside the queue settle before assertions. */
async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve()
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

describe('HudRenderQueue', () => {
  it('creates on first submit and latches startupSpent on success', async () => {
    const bridge = createMockBridge()
    const queue = new HudRenderQueue(bridge)
    const page = buildHudPage({ layout: 'text', header: 'H', body: 'B', footer: 'F' })

    queue.submit(page)
    await flush()

    expect(bridge.createStartUpPage).toHaveBeenCalledTimes(1)
    expect(queue.startupSpent).toBe(true)
  })

  it('latches startupSpent even when create fails, and falls through to rebuild', async () => {
    const bridge = createMockBridge()
    bridge.createStartUpPage.mockResolvedValueOnce('invalid' as StartupBuildResult)
    const queue = new HudRenderQueue(bridge)
    const page = buildHudPage({ layout: 'text', header: 'H', body: 'B', footer: 'F' })

    queue.submit(page)
    await flush()

    expect(queue.startupSpent).toBe(true)
    expect(bridge.rebuildPage).toHaveBeenCalledTimes(1)
    expect(bridge.rebuildPage).toHaveBeenCalledWith(page)
  })

  it('serializes calls: never more than one bridge call in flight, and coalesces to latest-wins', async () => {
    const bridge = createMockBridge()
    const gate = deferred<StartupBuildResult>()
    bridge.createStartUpPage.mockReturnValueOnce(gate.promise)
    const queue = new HudRenderQueue(bridge)

    const pageA = buildHudPage({ layout: 'text', header: 'A', body: 'A', footer: 'A' })
    const pageB = buildHudPage({ layout: 'text', header: 'B', body: 'B', footer: 'B' })
    const pageC = buildHudPage({ layout: 'text', header: 'C', body: 'C', footer: 'C' })

    queue.submit(pageA)
    await flush()
    expect(bridge.createStartUpPage).toHaveBeenCalledTimes(1)

    // Submitted while the first call is in flight: B is dropped, only C's shape matters.
    queue.submit(pageB)
    queue.submit(pageC)
    await flush()
    // still only the original in-flight call so far
    expect(bridge.createStartUpPage).toHaveBeenCalledTimes(1)

    gate.resolve('success')
    await flush()

    // Second real bridge action reflects pageC, never pageB.
    const secondCallPage = bridge.rebuildPage.mock.calls[0]?.[0] ?? bridge.upgradeText.mock.calls[0]
    expect(bridge.createStartUpPage).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(secondCallPage)).not.toContain('"B"')
  })

  it('retries a failed rebuild exactly once after the injected delay, then surfaces an error', async () => {
    const bridge = createMockBridge()
    const onRenderError = vi.fn()
    const scheduled: { cb: () => void; ms: number }[] = []
    const queue = new HudRenderQueue(bridge, {
      setTimeout: (cb, ms) => scheduled.push({ cb, ms }),
      onRenderError
    })

    const page1 = buildHudPage({ layout: 'text', header: 'H', body: 'B', footer: 'F' })
    queue.submit(page1)
    await flush()
    expect(queue.startupSpent).toBe(true)

    // Force a rebuild path: change list items is heavier; simplest is a geometry change,
    // but easiest deterministic rebuild trigger is 3+ text changes.
    const page2 = buildHudPage({ layout: 'text', header: 'H2', body: 'B2', footer: 'F2' })
    bridge.rebuildPage.mockResolvedValue(false)
    queue.submit(page2)
    await flush()

    expect(bridge.rebuildPage).toHaveBeenCalledTimes(1)
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0]?.ms).toBe(500)
    expect(onRenderError).not.toHaveBeenCalled()

    // Fire the retry.
    scheduled[0]?.cb()
    await flush()

    expect(bridge.rebuildPage).toHaveBeenCalledTimes(2)
    expect(onRenderError).toHaveBeenCalledTimes(1)
    // No further retries scheduled after the single retry fails.
    expect(scheduled).toHaveLength(1)
  })

  it('recovers previous page state when the retried rebuild succeeds', async () => {
    const bridge = createMockBridge()
    const scheduled: { cb: () => void; ms: number }[] = []
    const queue = new HudRenderQueue(bridge, { setTimeout: (cb, ms) => scheduled.push({ cb, ms }) })

    const page1 = buildHudPage({ layout: 'text', header: 'H', body: 'B', footer: 'F' })
    queue.submit(page1)
    await flush()

    const page2 = buildHudPage({ layout: 'text', header: 'H2', body: 'B2', footer: 'F2' })
    bridge.rebuildPage.mockResolvedValueOnce(false)
    bridge.rebuildPage.mockResolvedValueOnce(true)
    queue.submit(page2)
    await flush()

    scheduled[0]?.cb()
    await flush()

    expect(bridge.rebuildPage).toHaveBeenCalledTimes(2)
  })
})
