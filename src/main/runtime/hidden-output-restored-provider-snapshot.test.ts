import { describe, expect, it, vi } from 'vitest'
import { createRuntime, syncSinglePty } from './orca-runtime-test-fixtures.spec'

describe('hidden-output recovery after provider reattach', () => {
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
