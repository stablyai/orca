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

  it('spends the startup latch and falls through to rebuild when createStartUpPage rejects', async () => {
    const bridge = createMockBridge()
    bridge.createStartUpPage.mockRejectedValueOnce(new Error('bridge exploded'))
    const onRenderError = vi.fn()
    const queue = new HudRenderQueue(bridge, { onRenderError })
    const page = buildHudPage({ layout: 'text', header: 'H', body: 'B', footer: 'F' })

    queue.submit(page)
    await flush()

    // The one-shot latch must be spent even though the call threw, or a later submit would
    // illegally retry createStartUpPage (rejected by firmware, ~2.1s block per attempt).
    expect(queue.startupSpent).toBe(true)
    expect(bridge.rebuildPage).toHaveBeenCalledTimes(1)
    expect(bridge.rebuildPage).toHaveBeenCalledWith(page)
    expect(onRenderError).toHaveBeenCalled()
  })

  it('does not retry createStartUpPage on a later submit after a rejected create', async () => {
    const bridge = createMockBridge()
    bridge.createStartUpPage.mockRejectedValueOnce(new Error('bridge exploded'))
    const queue = new HudRenderQueue(bridge)
    const page1 = buildHudPage({ layout: 'text', header: 'H', body: 'B', footer: 'F' })
    queue.submit(page1)
    await flush()
    // The rejected create already fell through to a (successful, mocked) rebuild.
    expect(bridge.rebuildPage).toHaveBeenCalledTimes(1)

    const page2 = buildHudPage({ layout: 'text', header: 'H2', body: 'B2', footer: 'F2' })
    queue.submit(page2)
    await flush()

    expect(bridge.createStartUpPage).toHaveBeenCalledTimes(1)
    expect(bridge.rebuildPage).toHaveBeenCalledTimes(2)
  })

  it('drops (never sends) a page that fails HUD validation and reports the violation', async () => {
    const bridge = createMockBridge()
    const onRenderError = vi.fn()
    const queue = new HudRenderQueue(bridge, { onRenderError })
    const page = buildHudPage({ layout: 'text', header: 'H', body: 'B', footer: 'F' })
    // Force a violation (name > 16 chars) without going through buildHudPage's own truncation.
    page.containers[0] = {
      ...page.containers[0]!,
      name: 'x'.repeat(20)
    } as (typeof page.containers)[0]

    queue.submit(page)
    await flush()

    expect(bridge.createStartUpPage).not.toHaveBeenCalled()
    expect(bridge.rebuildPage).not.toHaveBeenCalled()
    expect(onRenderError).toHaveBeenCalledTimes(1)
    // The one-shot latch is untouched by a dropped page — it never reached the bridge.
    expect(queue.startupSpent).toBe(false)
  })

  it('drops an invalid upgrade payload instead of sending it, and does not fall back to an equally invalid rebuild', async () => {
    const bridge = createMockBridge()
    const onRenderError = vi.fn()
    const queue = new HudRenderQueue(bridge, { onRenderError })

    const page1 = buildHudPage({ layout: 'text', header: 'H', body: 'B', footer: 'F' })
    queue.submit(page1)
    await flush()

    const page2 = buildHudPage({ layout: 'text', header: 'H', body: 'B2', footer: 'F' })
    // Bypass buildHudPage's own <=1000-char truncation to force an over-limit upgrade payload
    // (>2000 chars) while keeping the container skeleton identical (still an 'upgrade' plan).
    page2.containers[1] = {
      ...page2.containers[1]!,
      content: 'x'.repeat(2500)
    } as (typeof page2.containers)[1]

    queue.submit(page2)
    await flush()

    expect(bridge.upgradeText).not.toHaveBeenCalled()
    // The oversized content also fails full-page validation, so the fallback rebuild is
    // dropped too rather than sending the same invalid content another way.
    expect(bridge.rebuildPage).not.toHaveBeenCalled()
    expect(onRenderError).toHaveBeenCalled()
  })

  it('invalidate() forces a rebuild on the next submit even with identical content, without re-spending create', async () => {
    const bridge = createMockBridge()
    const queue = new HudRenderQueue(bridge)
    const page = buildHudPage({ layout: 'text', header: 'H', body: 'B', footer: 'F' })

    queue.submit(page)
    await flush()
    expect(bridge.createStartUpPage).toHaveBeenCalledTimes(1)

    queue.invalidate()
    queue.submit(page) // identical content — would normally diff to 'noop'
    await flush()

    expect(bridge.rebuildPage).toHaveBeenCalledTimes(1)
    expect(bridge.rebuildPage).toHaveBeenCalledWith(page)
    // The one-shot startup API must never be retried just because the queue was invalidated.
    expect(bridge.createStartUpPage).toHaveBeenCalledTimes(1)
  })

  it('finding #5: a rejecting rebuildPage is treated as failure, reports the throw, and still retries/errors rather than an unhandled rejection', async () => {
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

    const page2 = buildHudPage({ layout: 'text', header: 'H2', body: 'B2', footer: 'F2' })
    bridge.rebuildPage.mockRejectedValueOnce(new Error('bridge exploded'))
    bridge.rebuildPage.mockRejectedValueOnce(new Error('bridge exploded again'))
    queue.submit(page2)
    await flush()

    expect(bridge.rebuildPage).toHaveBeenCalledTimes(1)
    expect(onRenderError).toHaveBeenCalledWith(expect.stringContaining('rebuildPage threw'))
    expect(scheduled).toHaveLength(1)

    scheduled[0]?.cb()
    await flush()

    expect(bridge.rebuildPage).toHaveBeenCalledTimes(2)
    expect(onRenderError).toHaveBeenCalledWith('rebuild failed after retry')
  })

  it('finding #5: recovers when a rejecting rebuildPage succeeds on the retry', async () => {
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

    const page2 = buildHudPage({ layout: 'text', header: 'H2', body: 'B2', footer: 'F2' })
    bridge.rebuildPage.mockRejectedValueOnce(new Error('bridge exploded'))
    queue.submit(page2)
    await flush()
    scheduled[0]?.cb()
    await flush()

    expect(bridge.rebuildPage).toHaveBeenCalledTimes(2)
    expect(onRenderError).toHaveBeenCalledTimes(1) // only the initial throw, no "failed after retry"

    // The successful retry updated `previous`, so an identical next submit is a noop.
    queue.submit(page2)
    await flush()
    expect(bridge.rebuildPage).toHaveBeenCalledTimes(2)
  })

  it('finding #5: a rejecting upgradeText is treated as failure and falls back to rebuild', async () => {
    const bridge = createMockBridge()
    const onRenderError = vi.fn()
    const queue = new HudRenderQueue(bridge, { onRenderError })

    const page1 = buildHudPage({ layout: 'text', header: 'H', body: 'B', footer: 'F' })
    queue.submit(page1)
    await flush()

    // Single-container text change -> 'upgrade' plan (<=2 changes), never 'rebuild'.
    const page2 = buildHudPage({ layout: 'text', header: 'H', body: 'B2', footer: 'F' })
    bridge.upgradeText.mockRejectedValueOnce(new Error('bridge exploded'))
    queue.submit(page2)
    await flush()

    expect(bridge.upgradeText).toHaveBeenCalledTimes(1)
    expect(onRenderError).toHaveBeenCalledWith(expect.stringContaining('upgradeText threw'))
    expect(bridge.rebuildPage).toHaveBeenCalledTimes(1)
    expect(bridge.rebuildPage).toHaveBeenCalledWith(page2)
  })

  it('finding #5: a submission queued while a rejecting bridge call is in flight still drains afterward', async () => {
    const bridge = createMockBridge()
    // Immediate (synchronous) retry delay — deterministic without relying on real timers.
    const queue = new HudRenderQueue(bridge, { setTimeout: (cb) => cb() })

    const page1 = buildHudPage({ layout: 'text', header: 'H', body: 'B', footer: 'F' })
    queue.submit(page1)
    await flush()

    const page2 = buildHudPage({ layout: 'text', header: 'H2', body: 'B2', footer: 'F2' })
    const page3 = buildHudPage({ layout: 'text', header: 'H3', body: 'B3', footer: 'F3' })
    // page2's first rebuild attempt rejects; the retry and page3's own rebuild both succeed
    // (default mock), so the queue must not get stuck on the rejected call.
    bridge.rebuildPage.mockRejectedValueOnce(new Error('boom'))
    queue.submit(page2)
    queue.submit(page3) // coalesces into `pending` while page2 is still being processed

    await flush(15)

    expect(bridge.rebuildPage.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(bridge.rebuildPage.mock.calls.at(-1)?.[0]).toEqual(page3)
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
