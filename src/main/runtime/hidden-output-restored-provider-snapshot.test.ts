import { afterEach, describe, expect, it, vi } from 'vitest'
import { AUTHORITATIVE_TERMINAL_SNAPSHOT_TIMEOUT_MS } from './orca-runtime-postlude'
import { createRuntime, syncSinglePty } from './orca-runtime-test-fixtures.spec'

afterEach(() => vi.useRealTimers())

describe('hidden-output recovery after provider reattach', () => {
  it('uses durable provider history when a desktop request exceeds the runtime mirror', async () => {
    const runtime = createRuntime()
    const serializeProviderBuffer = vi.fn().mockResolvedValue({
      data: 'oldest retained history\r\nnew output',
      cols: 80,
      rows: 24,
      seq: 10,
      source: 'headless'
    })
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      serializeProviderBuffer
    })
    syncSinglePty(runtime, 'pty-1')
    runtime.onPtyData('pty-1', 'new output', 100)
    const snapshot = await runtime.serializeHiddenOutputRecoveryBuffer('pty-1', {
      scrollbackRows: 100000
    })
    expect(snapshot?.data).toContain('oldest retained history')
    expect(serializeProviderBuffer).toHaveBeenCalled()
  })

  it('uses deeper renderer history when the provider has no snapshot support', async () => {
    const runtime = createRuntime()
    const serializeBuffer = vi.fn().mockResolvedValue({
      data: 'renderer retained history',
      cols: 80,
      rows: 24
    })
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      serializeProviderBuffer: async () => null,
      hasRendererSerializer: () => true,
      serializeBuffer
    })
    syncSinglePty(runtime, 'pty-1')
    runtime.onPtyData('pty-1', 'new output', 100)
    await expect(
      runtime.serializeHiddenOutputRecoveryBuffer('pty-1', {
        scrollbackRows: 100000
      })
    ).resolves.toMatchObject({ data: 'renderer retained history', source: 'renderer' })
    expect(serializeBuffer).toHaveBeenCalledWith('pty-1', { scrollbackRows: 100000 })
  })

  it('does not replace a live mirror with an empty parked renderer on a deep request', async () => {
    const runtime = createRuntime()
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      serializeProviderBuffer: async () => null,
      hasRendererSerializer: () => true,
      serializeBuffer: async () => ({ data: '', cols: 80, rows: 24 })
    })
    syncSinglePty(runtime, 'pty-1')
    runtime.onPtyData('pty-1', 'live content', 12)
    const snapshot = await runtime.serializeHiddenOutputRecoveryBuffer('pty-1', {
      scrollbackRows: 100000
    })
    expect(snapshot?.data).toContain('live content')
    expect(snapshot?.source).toBe('headless')
  })

  it('falls back to retained renderer history when a deep provider request stalls', async () => {
    vi.useFakeTimers()
    const runtime = createRuntime()
    let settleProvider!: (value: null) => void
    const serializeProviderBuffer = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<null>((resolve) => {
            settleProvider = resolve
          })
      )
      .mockResolvedValue({ data: 'provider recovered', cols: 80, rows: 24, seq: 10 })
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      serializeProviderBuffer,
      hasRendererSerializer: () => true,
      serializeBuffer: async () => ({ data: 'retained SSH history', cols: 80, rows: 24 })
    })
    syncSinglePty(runtime, 'pty-1')
    runtime.onPtyData('pty-1', 'new output', 10)
    const pending = runtime.serializeHiddenOutputRecoveryBuffer('pty-1', { scrollbackRows: 100000 })
    await vi.advanceTimersByTimeAsync(AUTHORITATIVE_TERMINAL_SNAPSHOT_TIMEOUT_MS)
    await expect(pending).resolves.toMatchObject({
      data: 'retained SSH history',
      source: 'renderer'
    })
    const retry = runtime.serializeHiddenOutputRecoveryBuffer('pty-1', { scrollbackRows: 100000 })
    let retrySettled = false
    void retry.then(() => {
      retrySettled = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(retrySettled).toBe(true)
    await expect(retry).resolves.toMatchObject({ data: 'retained SSH history' })
    expect(serializeProviderBuffer).toHaveBeenCalledTimes(1)
    settleProvider(null)
    await vi.advanceTimersByTimeAsync(0)
    await expect(
      runtime.serializeHiddenOutputRecoveryBuffer('pty-1', { scrollbackRows: 100000 })
    ).resolves.toMatchObject({ data: 'provider recovered' })
    expect(serializeProviderBuffer).toHaveBeenCalledTimes(2)
  })

  it('uses retained provider modes instead of the pre-attach redraw suffix', async () => {
    const runtime = createRuntime()
    const serializeProviderBuffer = vi.fn(async () => ({
      data: '\x1b[?1049hRetained TUI',
      cols: 100,
      rows: 30,
      seq: 1000,
      source: 'headless' as const,
      alternateScreen: true
    }))
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      serializeProviderBuffer
    })
    syncSinglePty(runtime, 'pty-1')
    runtime.onPtyData('pty-1', '\x1b[HRedraw without the original alternate-screen entry', 60)
    runtime.synchronizePtyOutputSequenceFromProvider('pty-1', {
      value: 1000,
      generation: 'continued'
    })

    const snapshot = await runtime.serializeHiddenOutputRecoveryBuffer('pty-1', {
      scrollbackRows: 5000
    })

    expect(snapshot).toMatchObject({ data: '\x1b[?1049hRetained TUI', alternateScreen: true })
    expect(serializeProviderBuffer).toHaveBeenCalledWith('pty-1', { scrollbackRows: 5000 })
  })

  it('keeps the renderer fallback for providers without retained snapshots', async () => {
    const runtime = createRuntime()
    runtime.onPtyData('pty-1', 'partial redraw', 14)
    runtime.synchronizePtyOutputSequenceFromProvider('pty-1', {
      value: 1000,
      generation: 'continued'
    })
    const serializeBuffer = vi.fn(async () => ({
      data: '\x1b[?1049hRenderer TUI',
      cols: 100,
      rows: 30
    }))
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      hasRendererSerializer: () => true,
      serializeBuffer
    })

    await expect(runtime.serializeHiddenOutputRecoveryBuffer('pty-1')).resolves.toMatchObject({
      data: '\x1b[?1049hRenderer TUI',
      source: 'renderer'
    })
  })

  it('keeps an authoritative main model without polling the provider', async () => {
    const runtime = createRuntime()
    const serializeProviderBuffer = vi.fn(async () => null)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      serializeProviderBuffer
    })
    runtime.onPtyData('pty-1', '\x1b[?1049hLive TUI', 20)

    await expect(runtime.serializeHiddenOutputRecoveryBuffer('pty-1')).resolves.toMatchObject({
      alternateScreen: true,
      source: 'headless'
    })
    expect(serializeProviderBuffer).not.toHaveBeenCalled()
  })
})
