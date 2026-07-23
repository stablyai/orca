import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PortScanner,
  SSH_PORT_SCAN_BASE_INTERVAL_MS,
  SSH_PORT_SCAN_MAX_INTERVAL_MS,
  type PortScannerWindowVisibility
} from './ssh-port-scanner'
import type { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import type { DetectedPort } from '../../shared/ssh-types'
import {
  SSH_DETECTED_PORTS_MAX_ENTRIES,
  SSH_DETECTED_PORT_PROCESS_NAME_MAX_UTF8_BYTES
} from '../../shared/ssh-retained-payload-admission'

type VisibilityHarness = {
  visibility: PortScannerWindowVisibility
  setVisible: (visible: boolean) => void
  listenerCount: () => number
}

function createVisibilityHarness(initiallyVisible: boolean): VisibilityHarness {
  let visible = initiallyVisible
  const listeners = new Set<() => void>()
  return {
    visibility: {
      isWindowVisible: () => visible,
      onWindowBecameVisible: (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      }
    },
    setVisible: (next) => {
      const wasVisible = visible
      visible = next
      if (!wasVisible && next) {
        for (const listener of Array.from(listeners)) {
          listener()
        }
      }
    },
    listenerCount: () => listeners.size
  }
}

function port(portNumber: number): DetectedPort {
  return { port: portNumber, host: '127.0.0.1', pid: 100 + portNumber, processName: 'node' }
}

function createMux(ports: () => DetectedPort[]): {
  mux: SshChannelMultiplexer
  request: ReturnType<typeof vi.fn>
} {
  const request = vi.fn(async () => ({ ports: ports(), platform: 'linux' }))
  return { mux: { request } as unknown as SshChannelMultiplexer, request }
}

const BASE = SSH_PORT_SCAN_BASE_INTERVAL_MS
const MAX = SSH_PORT_SCAN_MAX_INTERVAL_MS

describe('PortScanner', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends zero ports.detect requests while the window is hidden, then scans immediately on show', async () => {
    const harness = createVisibilityHarness(false)
    const { mux, request } = createMux(() => [port(3000)])
    const scanner = new PortScanner(harness.visibility)
    scanner.startScanning('t1', mux, vi.fn())

    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(request).not.toHaveBeenCalled()

    harness.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(request).toHaveBeenCalledTimes(1)

    scanner.dispose()
  })

  it('polls at the base cadence while visible when results keep changing', async () => {
    const harness = createVisibilityHarness(true)
    let next = 3000
    const { mux, request } = createMux(() => [port(next++)])
    const scanner = new PortScanner(harness.visibility)
    scanner.startScanning('t1', mux, vi.fn())

    await vi.advanceTimersByTimeAsync(0)
    expect(request).toHaveBeenCalledTimes(1)

    // 5 simulated base intervals -> 5 more scans (no backoff while changing).
    await vi.advanceTimersByTimeAsync(5 * BASE)
    expect(request).toHaveBeenCalledTimes(6)

    scanner.dispose()
  })

  it('doubles the interval up to the cap while unchanged and resets to base on a change', async () => {
    const harness = createVisibilityHarness(true)
    let ports = [port(3000)]
    const { mux, request } = createMux(() => ports)
    const onChanged = vi.fn()
    const scanner = new PortScanner(harness.visibility)
    scanner.startScanning('t1', mux, onChanged)

    // t=0: first scan is a change (empty -> {3000}) and stays at base.
    await vi.advanceTimersByTimeAsync(0)
    expect(request).toHaveBeenCalledTimes(1)
    expect(onChanged).toHaveBeenCalledTimes(1)

    // t=12s: unchanged -> next wait doubles to 24s.
    await vi.advanceTimersByTimeAsync(BASE)
    expect(request).toHaveBeenCalledTimes(2)

    // t=24s: nothing (waiting until t=36s).
    await vi.advanceTimersByTimeAsync(BASE)
    expect(request).toHaveBeenCalledTimes(2)

    // t=36s: unchanged -> next wait caps at 30s (not 48s).
    await vi.advanceTimersByTimeAsync(BASE)
    expect(request).toHaveBeenCalledTimes(3)

    // t=65.999s: still waiting.
    await vi.advanceTimersByTimeAsync(MAX - 1)
    expect(request).toHaveBeenCalledTimes(3)

    // t=66s: unchanged -> next wait remains capped at 30s.
    await vi.advanceTimersByTimeAsync(1)
    expect(request).toHaveBeenCalledTimes(4)

    await vi.advanceTimersByTimeAsync(MAX - 1)
    expect(request).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(1)
    expect(request).toHaveBeenCalledTimes(5)
    expect(onChanged).toHaveBeenCalledTimes(1)

    // A changed result resets the cadence back to base.
    ports = [port(3000), port(4000)]
    await vi.advanceTimersByTimeAsync(MAX)
    expect(request).toHaveBeenCalledTimes(6)
    expect(onChanged).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(BASE)
    expect(request).toHaveBeenCalledTimes(7)
    expect(scanner.getDetectedPorts('t1').map((p) => p.port)).toEqual([3000, 4000])

    scanner.dispose()
  })

  it('resets backoff and scans immediately when scanning restarts (reconnect/session-ready)', async () => {
    const harness = createVisibilityHarness(true)
    const { mux, request } = createMux(() => [port(3000)])
    const scanner = new PortScanner(harness.visibility)
    const onChanged = vi.fn()
    scanner.startScanning('t1', mux, onChanged)

    // Back off: scans at t=0, t=12s, t=36s -> interval now 48s.
    await vi.advanceTimersByTimeAsync(3 * BASE)
    expect(request).toHaveBeenCalledTimes(3)

    // Reconnect paths call startScanning again: immediate scan, base cadence.
    scanner.startScanning('t1', mux, onChanged)
    await vi.advanceTimersByTimeAsync(0)
    expect(request).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(BASE)
    expect(request).toHaveBeenCalledTimes(5)

    scanner.dispose()
  })

  it('parks when the window hides mid-run and resumes with an immediate scan on show', async () => {
    const harness = createVisibilityHarness(true)
    let next = 3000
    const { mux, request } = createMux(() => [port(next++)])
    const scanner = new PortScanner(harness.visibility)
    scanner.startScanning('t1', mux, vi.fn())

    await vi.advanceTimersByTimeAsync(BASE)
    expect(request).toHaveBeenCalledTimes(2)

    harness.setVisible(false)
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(request).toHaveBeenCalledTimes(2)

    harness.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(request).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(BASE)
    expect(request).toHaveBeenCalledTimes(4)

    scanner.dispose()
  })

  it('never overlaps a slow in-flight request and resumes the chain after it settles', async () => {
    const harness = createVisibilityHarness(true)
    let resolveFirst: ((value: { ports: DetectedPort[]; platform: string }) => void) | null = null
    const request = vi.fn(
      () =>
        new Promise<{ ports: DetectedPort[]; platform: string }>((resolve) => {
          resolveFirst = resolve
        })
    )
    const scanner = new PortScanner(harness.visibility)
    scanner.startScanning('t1', { request } as unknown as SshChannelMultiplexer, vi.fn())
    expect(request).toHaveBeenCalledTimes(1)

    // The chain waits for the in-flight request instead of stacking more.
    await vi.advanceTimersByTimeAsync(10 * BASE)
    expect(request).toHaveBeenCalledTimes(1)

    resolveFirst!({ ports: [port(3000)], platform: 'linux' })
    await vi.advanceTimersByTimeAsync(BASE)
    expect(request).toHaveBeenCalledTimes(2)

    scanner.dispose()
  })

  it('bounds remote rows before retaining or publishing a scan', async () => {
    const harness = createVisibilityHarness(true)
    const remoteRows = Array.from({ length: SSH_DETECTED_PORTS_MAX_ENTRIES + 20 }, (_, index) => ({
      ...port(3000 + index),
      processName: 'x'.repeat(SSH_DETECTED_PORT_PROCESS_NAME_MAX_UTF8_BYTES + 100)
    }))
    const { mux } = createMux(() => remoteRows)
    const onChanged = vi.fn()
    const scanner = new PortScanner(harness.visibility)

    scanner.startScanning('t1', mux, onChanged)
    await vi.advanceTimersByTimeAsync(0)

    const retained = scanner.getDetectedPorts('t1')
    expect(retained).toHaveLength(SSH_DETECTED_PORTS_MAX_ENTRIES)
    expect(retained[0].processName).toHaveLength(SSH_DETECTED_PORT_PROCESS_NAME_MAX_UTF8_BYTES)
    expect(onChanged).toHaveBeenCalledWith('t1', retained, 'linux')
    scanner.dispose()
  })

  it('stopScanning halts polling and detaches the visibility listener', async () => {
    const harness = createVisibilityHarness(true)
    const { mux, request } = createMux(() => [port(3000)])
    const scanner = new PortScanner(harness.visibility)
    scanner.startScanning('t1', mux, vi.fn())
    await vi.advanceTimersByTimeAsync(0)
    expect(request).toHaveBeenCalledTimes(1)
    expect(harness.listenerCount()).toBe(1)

    scanner.stopScanning('t1')
    expect(harness.listenerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    harness.setVisible(false)
    harness.setVisible(true)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(request).toHaveBeenCalledTimes(1)
    expect(scanner.getDetectedPorts('t1')).toEqual([])
  })

  it('keeps targets independent: stopping one host leaves the other scanning', async () => {
    const harness = createVisibilityHarness(true)
    let nextA = 3000
    let nextB = 4000
    const a = createMux(() => [port(nextA++)])
    const b = createMux(() => [port(nextB++)])
    const scanner = new PortScanner(harness.visibility)
    scanner.startScanning('host-a', a.mux, vi.fn())
    scanner.startScanning('host-b', b.mux, vi.fn())
    await vi.advanceTimersByTimeAsync(0)
    expect(a.request).toHaveBeenCalledTimes(1)
    expect(b.request).toHaveBeenCalledTimes(1)

    scanner.stopScanning('host-a')
    await vi.advanceTimersByTimeAsync(BASE)
    expect(a.request).toHaveBeenCalledTimes(1)
    expect(b.request).toHaveBeenCalledTimes(2)

    scanner.dispose()
    await vi.advanceTimersByTimeAsync(10 * BASE)
    expect(b.request).toHaveBeenCalledTimes(2)
    expect(harness.listenerCount()).toBe(0)
  })
})
