import { describe, expect, it, vi } from 'vitest'
import './runtime-test-module-registration.spec'
import { AUTHORITATIVE_TERMINAL_SNAPSHOT_TIMEOUT_MS } from '../terminal/output/provider-snapshot-budget'
import '../orca-runtime'
import { syncSinglePty } from './orca-runtime-test-fixtures.spec'
import { createSideEffectRuntime } from './orca-runtime-test-scenario-builders.spec'

describe('terminal side-effect fact channel', () => {
  it('bounds a hung authoritative provider acquisition and reuses its fallback', async () => {
    vi.useFakeTimers()
    try {
      let releaseProvider: (value: null) => void = () => {}
      const hungProvider = new Promise<null>((resolve) => {
        releaseProvider = resolve
      })
      const serializeProviderBuffer = vi
        .fn()
        .mockReturnValueOnce(hungProvider)
        .mockResolvedValueOnce({
          data: 'provider recovered\r\n',
          cols: 100,
          rows: 30,
          seq: 200,
          source: 'headless'
        })
      const { runtime } = createSideEffectRuntime()
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null,
        serializeProviderBuffer,
        hasRendererSerializer: () => false
      })
      syncSinglePty(runtime)
      runtime.onPtyData('pty-1', 'available mirror\r\n', 100)

      const firstSnapshot = runtime.serializeAuthoritativeTerminalBuffer('pty-1', {
        scrollbackRows: 5000
      })
      const concurrentSnapshot = runtime.serializeAuthoritativeTerminalBuffer('pty-1', {
        scrollbackRows: 5000
      })
      expect(serializeProviderBuffer).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(AUTHORITATIVE_TERMINAL_SNAPSHOT_TIMEOUT_MS)
      await expect(firstSnapshot).resolves.toMatchObject({
        data: expect.stringContaining('available mirror'),
        source: 'headless'
      })
      await expect(concurrentSnapshot).resolves.toMatchObject({
        data: expect.stringContaining('available mirror'),
        source: 'headless'
      })

      await expect(
        runtime.serializeAuthoritativeTerminalBuffer('pty-1', { scrollbackRows: 5000 })
      ).resolves.toMatchObject({
        data: expect.stringContaining('available mirror'),
        source: 'headless'
      })
      expect(serializeProviderBuffer).toHaveBeenCalledOnce()

      releaseProvider(null)
      await vi.advanceTimersByTimeAsync(0)
      await expect(
        runtime.serializeAuthoritativeTerminalBuffer('pty-1', { scrollbackRows: 5000 })
      ).resolves.toMatchObject({
        data: 'provider recovered\r\n',
        source: 'headless'
      })
      expect(serializeProviderBuffer).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls back to provider history when a mounted renderer has not hydrated yet', async () => {
    const { runtime } = createSideEffectRuntime()
    const serializeBuffer = vi.fn().mockResolvedValue({
      data: '',
      cols: 80,
      rows: 24
    })
    const serializeProviderBuffer = vi.fn().mockResolvedValue({
      data: '',
      scrollbackAnsi: 'restored history\r\n',
      cols: 120,
      rows: 40,
      seq: 900,
      source: 'headless'
    })
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      serializeBuffer,
      serializeProviderBuffer,
      hasRendererSerializer: () => true
    })

    const snapshot = await runtime.serializeTerminalBuffer('pty-restored', {
      scrollbackRows: 5000
    })

    expect(serializeBuffer).toHaveBeenCalledOnce()
    expect(serializeProviderBuffer).toHaveBeenCalledWith('pty-restored', {
      scrollbackRows: 5000
    })
    expect(snapshot).toMatchObject({
      data: '',
      scrollbackAnsi: 'restored history\r\n',
      source: 'headless'
    })
  })

  it('does not let pre-response bytes hide restored provider history', async () => {
    const { runtime } = createSideEffectRuntime()
    const serializeProviderBuffer = vi.fn().mockResolvedValue({
      data: 'restored history\r\nqueued',
      cols: 80,
      rows: 24,
      seq: 906,
      source: 'headless'
    })
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      serializeProviderBuffer,
      hasRendererSerializer: () => false
    })
    runtime.onPtyData('pty-restored', 'queued', 100)
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-restored',
      { value: 900, generation: 'continued' },
      0
    )

    const snapshot = await runtime.serializeTerminalBuffer('pty-restored', {
      scrollbackRows: 5000
    })

    expect(snapshot?.data).toContain('restored history')
    expect(serializeProviderBuffer).toHaveBeenCalledOnce()
  })

  it('keeps mode transitions that race a provider snapshot response', async () => {
    const { runtime } = createSideEffectRuntime()
    let resolveProviderSnapshot:
      | ((snapshot: {
          data: string
          cols: number
          rows: number
          seq: number
          source: 'headless'
          alternateScreen: boolean
        }) => void)
      | undefined
    const serializeProviderBuffer = vi.fn(
      () =>
        new Promise<{
          data: string
          cols: number
          rows: number
          seq: number
          source: 'headless'
          alternateScreen: boolean
        }>((resolve) => {
          resolveProviderSnapshot = resolve
        })
    )
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      serializeProviderBuffer,
      hasRendererSerializer: () => false
    })
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-tui-race',
      { value: 900, generation: 'continued' },
      0
    )

    const snapshotPromise = runtime.serializeTerminalBuffer('pty-tui-race')
    await vi.waitFor(() => expect(resolveProviderSnapshot).toBeDefined())
    runtime.onPtyData('pty-tui-race', '\x1b[?1049l', 100)
    resolveProviderSnapshot?.({
      data: 'captured alt screen',
      cols: 80,
      rows: 24,
      seq: 900,
      source: 'headless',
      alternateScreen: true
    })
    await snapshotPromise

    expect(runtime.isTerminalAlternateScreen('pty-tui-race')).toBe(false)
  })

  it('parses synthetic frames statelessly so ticks cannot corrupt the bell detector', () => {
    const { runtime, batches } = createSideEffectRuntime()
    syncSinglePty(runtime)

    runtime.onPtyData('pty-1', '\x1b]0;split ti', 100)
    // An 80ms spinner tick lands between the two halves of the real OSC.
    runtime.ingestSyntheticTitleFrame('pty-1', '\x1b]0;⠋ Cursor Agent\x07')
    // This BEL terminates the real partial OSC; it is not a bell.
    runtime.onPtyData('pty-1', 'tle\x07', 101)
    // A later standalone BEL must still produce a bell fact.
    runtime.onPtyData('pty-1', 'ready\x07', 102)

    expect(batches.flatMap((batch) => batch.facts)).toEqual([
      { kind: 'title', normalizedTitle: '⠋ Cursor Agent', rawTitle: '⠋ Cursor Agent' },
      { kind: 'agent-working' },
      { kind: 'title', normalizedTitle: 'split title', rawTitle: 'split title' },
      { kind: 'bell' }
    ])
  })
})
