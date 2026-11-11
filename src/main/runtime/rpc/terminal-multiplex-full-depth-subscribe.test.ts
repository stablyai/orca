import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FULL_DEPTH_SNAPSHOT_INTERVAL_MS,
  resetFullDepthSnapshotLimitForTests
} from './methods/terminal/terminal-full-depth-snapshot-limit'
import {
  sendDesktopMultiplexSubscribe,
  startDesktopMultiplexSubscribe
} from './terminal-multiplex-test-harness'

const DESKTOP_CAPS = { ackOutput: 1, desktopViewportClaims: 1 } as const

/** One connection's subscribe; returns the scrollback depth its initial snapshot asked the host for. */
async function subscribeDepth(extra: Record<string, unknown> = {}): Promise<number | undefined> {
  const serializeTerminalBuffer = vi.fn(
    async (_ptyId: string, _opts?: { scrollbackRows?: number }) => ({
      data: 'history\r\nscreen',
      cols: 120,
      rows: 40,
      seq: 1
    })
  )
  const harness = startDesktopMultiplexSubscribe({ serializeTerminalBuffer })
  await vi.waitFor(() =>
    expect(harness.messages.some((m) => JSON.parse(m).result?.type === 'ready')).toBe(true)
  )
  sendDesktopMultiplexSubscribe(harness.handlers, { ...DESKTOP_CAPS }, extra)
  await vi.waitFor(() => expect(serializeTerminalBuffer).toHaveBeenCalled())
  const depth = serializeTerminalBuffer.mock.calls[0]?.[1]?.scrollbackRows
  harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
  await harness.dispatchPromise
  return depth
}

// N-02: full depth only when the desktop has no local copy of the pane; reconnects stay small.
describe('desktop subscribe history depth', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-11T21:00:00Z'))
    resetFullDepthSnapshotLimitForTests()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('an app reopen (no local copy) gets a local terminal depth', async () => {
    expect(await subscribeDepth({ historyDepth: 'full' })).toBe(5000)
  })

  it('a reconnect storm gets the 1000-row cut every time', async () => {
    const depths: (number | undefined)[] = []
    for (let i = 0; i < 6; i++) {
      depths.push(await subscribeDepth())
    }
    expect(depths).toEqual([1000, 1000, 1000, 1000, 1000, 1000])
  })

  it('a client that asks for full depth on every reconnect gets it once per pane per interval', async () => {
    // The harness's waits move the fake clock a little per subscribe, so the edges keep a 1 s margin.
    const start = Date.now()
    expect(await subscribeDepth({ historyDepth: 'full' })).toBe(5000)
    expect(await subscribeDepth({ historyDepth: 'full' })).toBe(1000)
    vi.setSystemTime(start + FULL_DEPTH_SNAPSHOT_INTERVAL_MS - 1000)
    expect(await subscribeDepth({ historyDepth: 'full' })).toBe(1000)
    vi.setSystemTime(start + FULL_DEPTH_SNAPSHOT_INTERVAL_MS + 1000)
    expect(await subscribeDepth({ historyDepth: 'full' })).toBe(5000)
  })
})
