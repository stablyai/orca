import { expect, it, vi } from 'vitest'
import { DAEMON_SESSION_SCROLLBACK_ROWS } from '../daemon/daemon-session-scrollback-window'
import { AUTHORITATIVE_TERMINAL_SNAPSHOT_TIMEOUT_MS } from './orca-runtime-postlude'
import type { PtyProviderBufferSnapshot } from '../providers/pty-provider-contract'
import { deferred } from './orca-runtime-test-fixtures.spec'
import { createHydrationRuntime, PTY_ID, SIZE } from './headless-hydration-ownership-test-fixture'

it('retains only the configured scrollback depth', async () => {
  const runtime = createHydrationRuntime({
    headlessTerminalScrollbackRows: DAEMON_SESSION_SCROLLBACK_ROWS
  })
  const lines = Array.from({ length: 3000 }, (_, i) => `L${String(i + 1).padStart(4, '0')}`)
  runtime.onPtyData(PTY_ID, lines.join('\r\n'), 1)
  await runtime.model().writeChain
  const snapshot = await runtime.serializeMainTerminalBuffer(PTY_ID, { scrollbackRows: 5000 })
  const retained = `${snapshot?.scrollbackAnsi ?? ''}${snapshot?.data ?? ''}`.match(/L\d{4}/g)
  expect(retained).toHaveLength(DAEMON_SESSION_SCROLLBACK_ROWS + SIZE.rows)
  expect(retained?.at(-1)).toBe('L3000')
})

function hangingProvider() {
  const runtime = createHydrationRuntime()
  const late = deferred<PtyProviderBufferSnapshot | null>()
  const serializeProviderBuffer = vi
    .fn<() => Promise<PtyProviderBufferSnapshot | null>>()
    .mockReturnValueOnce(late.promise)
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    getSize: () => SIZE,
    serializeProviderBuffer
  })
  return { runtime, late, serializeProviderBuffer }
}

it('bounds a provider snapshot that does not answer, then reseeds once it lands', async () => {
  vi.useFakeTimers()
  try {
    const { runtime, late, serializeProviderBuffer } = hangingProvider()
    runtime.replaceExecutionContext()
    const stalled = runtime.model()
    runtime.onPtyData(PTY_ID, 'LIVE-AFTER-SEED', 1)
    await vi.advanceTimersByTimeAsync(AUTHORITATIVE_TERMINAL_SNAPSHOT_TIMEOUT_MS)
    await stalled.writeChain
    expect(stalled.emulator.getVisibleLines().join('\n')).toContain('LIVE-AFTER-SEED')
    // Partial until a seed lands, so readers keep asking the provider.
    expect(runtime.retainedState().providerPreferred).toBe(true)

    serializeProviderBuffer.mockResolvedValue({
      ...SIZE,
      data: 'FRESH-SEED',
      seq: 1,
      source: 'headless'
    })
    late.resolve({ ...SIZE, data: 'LATE-SEED', seq: 0, source: 'headless' })
    await vi.waitFor(() => expect(runtime.model()).not.toBe(stalled))
    await runtime.model().writeChain
    expect(runtime.model().emulator.getVisibleLines().join('\n')).toContain('FRESH-SEED')
    expect(runtime.retainedState().providerPreferred).toBe(false)
  } finally {
    vi.useRealTimers()
  }
})

it('keeps preferring the provider when the late retry finds no snapshot', async () => {
  vi.useFakeTimers()
  try {
    const { runtime, late, serializeProviderBuffer } = hangingProvider()
    runtime.replaceExecutionContext()
    const stalled = runtime.model()
    await vi.advanceTimersByTimeAsync(AUTHORITATIVE_TERMINAL_SNAPSHOT_TIMEOUT_MS)
    serializeProviderBuffer.mockResolvedValue(null)
    late.resolve({ ...SIZE, data: 'LATE-SEED', seq: 0, source: 'headless' })
    await vi.waitFor(() => expect(runtime.model()).not.toBe(stalled))
    await runtime.model().writeChain
    // The retry's model lost what its predecessor held, so it must not become authoritative.
    expect(runtime.retainedState().providerPreferred).toBe(true)
  } finally {
    vi.useRealTimers()
  }
})

it('trusts the model when a timed-out capture lands with no snapshot', async () => {
  vi.useFakeTimers()
  try {
    const { runtime, late, serializeProviderBuffer } = hangingProvider()
    runtime.replaceExecutionContext()
    const model = runtime.model()
    await vi.advanceTimersByTimeAsync(AUTHORITATIVE_TERMINAL_SNAPSHOT_TIMEOUT_MS)
    late.resolve(null)
    await vi.waitFor(() => expect(runtime.retainedState().providerPreferred).toBe(false))
    expect(runtime.model()).toBe(model)
    expect(serializeProviderBuffer).toHaveBeenCalledOnce()
  } finally {
    vi.useRealTimers()
  }
})

it('bounds every reader of a provider snapshot that does not answer', async () => {
  vi.useFakeTimers()
  try {
    const { runtime } = hangingProvider()
    runtime.preferProvider()
    const read = runtime.serializeTerminalBuffer(PTY_ID)
    // Preferred-provider read, then the no-model fallback: two bounded waits.
    await vi.advanceTimersByTimeAsync(2 * AUTHORITATIVE_TERMINAL_SNAPSHOT_TIMEOUT_MS)
    await expect(read).resolves.toBeNull()
  } finally {
    vi.useRealTimers()
  }
})
