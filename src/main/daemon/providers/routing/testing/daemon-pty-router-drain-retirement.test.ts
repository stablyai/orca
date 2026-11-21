import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAdapter } from './daemon-pty-router-test-fixture'
import { DaemonPtyRouter } from '../daemon-pty-router'

// Why: drain retirement telemetry is real-module noise here; the router itself never emits it.
vi.mock('../../../observability/daemon-lifecycle-event', () => ({ trackDaemonRetired: vi.fn() }))

const DRAIN_DEBOUNCE_MS = 5_000

// #9138: a legacy generation whose sessions all exited must not outlive the drain —
// the app's own legacy event connection blocks the daemon-side last-disconnect
// retirement, so the router has to ask once the exits settle.
describe('DaemonPtyRouter legacy drain retirement', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('retires and detaches a drained legacy adapter once its exits settle', async () => {
    const current = createAdapter('current')
    const legacy = createAdapter('legacy', ['legacy-session'])
    const router = new DaemonPtyRouter({ current, legacy: [legacy] })
    await router.discoverLegacySessions()
    expect(router.getLegacyAdapters()).toContain(legacy)

    await router.shutdown('legacy-session', { immediate: true })
    legacy.emitExit('legacy-session', 0)
    await vi.advanceTimersByTimeAsync(DRAIN_DEBOUNCE_MS)

    expect(legacy.requestIdleRetirement).toHaveBeenCalledOnce()
    expect(router.getLegacyAdapters()).not.toContain(legacy)
    expect(legacy.disconnectOnly).toHaveBeenCalled()
  })

  it('drops a pending drain check when the router disconnects its adapters', async () => {
    const current = createAdapter('current')
    const legacy = createAdapter('legacy', ['legacy-session'])
    const router = new DaemonPtyRouter({ current, legacy: [legacy] })
    await router.discoverLegacySessions()

    await router.shutdown('legacy-session', { immediate: true })
    legacy.emitExit('legacy-session', 0)
    await router.disconnectOnly()
    await vi.advanceTimersByTimeAsync(DRAIN_DEBOUNCE_MS)

    // Why: a check firing after the teardown would reconnect the socket it just closed.
    expect(legacy.requestIdleRetirement).not.toHaveBeenCalled()
  })

  it('keeps a legacy adapter that still routes a live session', async () => {
    const current = createAdapter('current')
    const legacy = createAdapter('legacy', ['live-session', 'exiting-session'])
    const router = new DaemonPtyRouter({ current, legacy: [legacy] })
    await router.discoverLegacySessions()

    legacy.emitExit('exiting-session', 0)
    await vi.advanceTimersByTimeAsync(DRAIN_DEBOUNCE_MS * 2)

    expect(legacy.requestIdleRetirement).not.toHaveBeenCalled()
    expect(router.getLegacyAdapters()).toContain(legacy)
  })

  it('never drains the current generation', async () => {
    const current = createAdapter('current', ['current-session'])
    new DaemonPtyRouter({ current, legacy: [] })

    current.emitExit('current-session', 0)
    await vi.advanceTimersByTimeAsync(DRAIN_DEBOUNCE_MS * 2)

    expect(current.requestIdleRetirement).not.toHaveBeenCalled()
  })

  it('stops querying a legacy adapter it retired', async () => {
    const current = createAdapter('current')
    const legacy = createAdapter('legacy')
    const router = new DaemonPtyRouter({ current, legacy: [legacy] })

    await router.discoverLegacySessions()
    await vi.advanceTimersByTimeAsync(0)
    expect(router.getLegacyAdapters()).not.toContain(legacy)
    vi.mocked(legacy.listProcesses).mockClear()

    await router.listProcesses()

    expect(legacy.listProcesses).not.toHaveBeenCalled()
  })

  it('sweeps generations that drained while no app was running at discovery time', async () => {
    const current = createAdapter('current')
    const legacy = createAdapter('legacy')
    const router = new DaemonPtyRouter({ current, legacy: [legacy] })

    await router.discoverLegacySessions()
    // Why zero: the sweep is fire-and-forget; flush its microtasks without waiting the debounce.
    await vi.advanceTimersByTimeAsync(0)

    expect(legacy.requestIdleRetirement).toHaveBeenCalledOnce()
    expect(router.getLegacyAdapters()).not.toContain(legacy)
  })
})
