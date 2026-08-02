import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import { probeLegacyDaemonInput } from './legacy-daemon-input-probe'

type ProbeMode = 'healthy' | 'blackhole' | 'unknown'

function createProbeAdapter(mode: ProbeMode) {
  let onData: ((payload: { id: string; data: string }) => void) | null = null
  const spawn = vi.fn(async (opts: { sessionId?: string; command?: string }) => {
    if (mode === 'unknown') {
      throw new Error('legacy daemon unavailable')
    }
    if (mode === 'healthy') {
      const token = opts.command?.match(/'(orca-legacy-input-ok-[^']+)'/)?.[1]
      queueMicrotask(() => {
        if (opts.sessionId && token) {
          onData?.({ id: opts.sessionId, data: token })
        }
      })
    }
    return { id: opts.sessionId ?? 'probe' }
  })
  const shutdown = vi.fn(async () => {})
  return {
    adapter: {
      spawn,
      shutdown,
      onData: (callback: typeof onData) => {
        onData = callback
        return () => {
          onData = null
        }
      },
      onExit: () => () => {}
    } as unknown as DaemonPtyAdapter,
    spawn,
    shutdown
  }
}

describe('legacy daemon input probe', () => {
  afterEach(() => vi.useRealTimers())

  it('accepts a legacy endpoint only after real PTY output proves input delivery', async () => {
    const { adapter, spawn, shutdown } = createProbeAdapter('healthy')

    await expect(probeLegacyDaemonInput(adapter, '/tmp')).resolves.toBe(true)
    expect(spawn).toHaveBeenCalledOnce()
    expect(shutdown).toHaveBeenCalledOnce()
  })

  it('rejects a repeatable ACK-without-output blackhole without killing user sessions', async () => {
    vi.useFakeTimers()
    const { adapter, spawn, shutdown } = createProbeAdapter('blackhole')

    const health = probeLegacyDaemonInput(adapter, '/tmp')
    await vi.runAllTimersAsync()

    await expect(health).resolves.toBe(false)
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(shutdown).toHaveBeenCalledTimes(2)
  })

  it('fails closed when legacy input health cannot be determined', async () => {
    const { adapter, spawn, shutdown } = createProbeAdapter('unknown')

    await expect(probeLegacyDaemonInput(adapter, '/tmp')).resolves.toBe(false)
    expect(spawn).toHaveBeenCalledOnce()
    expect(shutdown).not.toHaveBeenCalled()
  })
})
