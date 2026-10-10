import { describe, expect, it, vi } from 'vitest'
import {
  AUTHORITATIVE_TERMINAL_SNAPSHOT_TIMEOUT_MS,
  OrcaRuntimeService
} from '../orca-runtime-test-mocks.spec'
import { store, syncSinglePty } from '../orca-runtime-test-fixtures.spec'
import { createSideEffectRuntime } from '../orca-runtime-test-scenario-builders.spec'

describe('terminal side-effect fact channel', () => {
  it('emits 2031-subscribe facts across chunk splits', () => {
    // Why: hidden-delivery-gated views never get the bytes, so this fact is their only cue to send the DECSET 2031 color-scheme reply.
    const { runtime, batches } = createSideEffectRuntime()
    syncSinglePty(runtime)

    runtime.onPtyData('pty-1', '\x1b[?20', 100)
    expect(batches).toEqual([])
    runtime.onPtyData('pty-1', '31h', 101)

    expect(batches.flatMap((batch) => batch.facts)).toEqual([{ kind: '2031-subscribe' }])
  })

  it('restores a provisional 2031 subscribe when daemon scan authority returns', () => {
    const { runtime, batches } = createSideEffectRuntime()
    syncSinglePty(runtime)

    runtime.setPtyTransientFactDelegation('pty-1', true)
    runtime.setPtyTransientFactDelegation('pty-1', false, '\x1b[?', true)
    runtime.onPtyData('pty-1', '25h', 100)

    expect(batches.flatMap((batch) => batch.facts)).toEqual([{ kind: '2031-subscribe' }])
  })

  it('prefers the tracked title over the renderer snapshot lastTitle', async () => {
    const { runtime } = createSideEffectRuntime()
    const serializeBuffer = vi.fn().mockResolvedValue({
      data: 'visible content',
      cols: 80,
      rows: 24,
      // Renderer xterm never saw the synthetic frame (no longer rides pty:data), so its serializer reports a stale title.
      lastTitle: 'stale shell title'
    })
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      serializeBuffer,
      hasRendererSerializer: () => true,
      getSize: () => ({ cols: 80, rows: 24 })
    })
    syncSinglePty(runtime)

    runtime.ingestSyntheticTitleFrame('pty-1', '\x1b]0;⠋ Cursor Agent\x07')

    const snapshot = await runtime.serializeTerminalBuffer('pty-1', { scrollbackRows: 10 })
    expect(snapshot?.source).toBe('renderer')
    expect(snapshot?.lastTitle).toBe('⠋ Cursor Agent')
  })

  it('falls back to the provider snapshot for a restored PTY with no mounted renderer', async () => {
    const { runtime } = createSideEffectRuntime()
    const serializeBuffer = vi.fn()
    const serializeProviderBuffer = vi.fn().mockResolvedValue({
      data: 'restored screen\r\n',
      scrollbackAnsi: 'restored history\r\n',
      cols: 120,
      rows: 40,
      cwd: '/projects/restored',
      seq: 900,
      source: 'headless'
    })
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      serializeBuffer,
      serializeProviderBuffer,
      hasRendererSerializer: () => false
    })

    const snapshot = await runtime.serializeTerminalBuffer('pty-restored', {
      scrollbackRows: 5000
    })

    expect(serializeBuffer).not.toHaveBeenCalled()
    expect(serializeProviderBuffer).toHaveBeenCalledWith('pty-restored', {
      scrollbackRows: 5000
    })
    expect(snapshot).toEqual({
      data: 'restored screen\r\n',
      scrollbackAnsi: 'restored history\r\n',
      cols: 120,
      rows: 40,
      cwd: '/projects/restored',
      seq: 900,
      source: 'headless'
    })
  })

  it('prefers provider history over a partial headless mirror for requested snapshots', async () => {
    const { runtime } = createSideEffectRuntime()
    const serializeProviderBuffer = vi.fn().mockResolvedValue({
      data: 'authoritative screen\r\n',
      scrollbackAnsi: 'deep provider history\r\n',
      cols: 120,
      rows: 40,
      seq: 900,
      source: 'headless'
    })
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      serializeProviderBuffer,
      hasRendererSerializer: () => false
    })
    syncSinglePty(runtime)
    runtime.onPtyData('pty-1', 'partial current screen\r\n', 100)

    await expect(
      runtime.serializeAuthoritativeTerminalBuffer('pty-1', { scrollbackRows: 5000 })
    ).resolves.toMatchObject({
      data: 'authoritative screen\r\n',
      scrollbackAnsi: 'deep provider history\r\n',
      seq: 900
    })
    expect(serializeProviderBuffer).toHaveBeenCalledWith('pty-1', {
      scrollbackRows: 5000
    })
  })

  it('falls back to the available mirror when authoritative provider history is unavailable', async () => {
    const { runtime } = createSideEffectRuntime()
    const serializeProviderBuffer = vi.fn().mockResolvedValue(null)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      serializeProviderBuffer,
      hasRendererSerializer: () => false
    })
    syncSinglePty(runtime)
    runtime.onPtyData('pty-1', 'partial current screen\r\n', 100)

    await expect(
      runtime.serializeAuthoritativeTerminalBuffer('pty-1', { scrollbackRows: 5000 })
    ).resolves.toMatchObject({
      data: expect.stringContaining('partial current screen'),
      source: 'headless'
    })
    expect(serializeProviderBuffer).toHaveBeenCalledWith('pty-1', {
      scrollbackRows: 5000
    })
  })

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

  it('keeps an empty renderer snapshot when the provider has no retained content', async () => {
    const { runtime } = createSideEffectRuntime()
    const serializeProviderBuffer = vi.fn().mockResolvedValue({
      data: '',
      scrollbackAnsi: '',
      cols: 120,
      rows: 40,
      seq: 0,
      source: 'headless'
    })
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      serializeBuffer: vi.fn().mockResolvedValue({ data: '', cols: 51, rows: 40 }),
      serializeProviderBuffer,
      hasRendererSerializer: () => true
    })

    const snapshot = await runtime.serializeTerminalBuffer('pty-new')

    expect(serializeProviderBuffer).toHaveBeenCalledOnce()
    expect(snapshot).toMatchObject({ data: '', cols: 51, rows: 40, source: 'renderer' })
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

  it('keeps restored provider history authoritative after later live output', async () => {
    const { runtime } = createSideEffectRuntime()
    const serializeProviderBuffer = vi.fn().mockResolvedValue({
      data: 'restored history\r\nlater output',
      cols: 80,
      rows: 24,
      seq: 912,
      source: 'headless'
    })
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      serializeProviderBuffer,
      hasRendererSerializer: () => false
    })
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-restored',
      { value: 900, generation: 'continued' },
      0
    )
    runtime.onPtyData('pty-restored', 'later output', 100)

    const snapshot = await runtime.serializeTerminalBuffer('pty-restored')

    expect(snapshot?.data).toContain('restored history')
    expect(serializeProviderBuffer).toHaveBeenCalledOnce()
  })

  it('uses provider alternate-screen state while a partial model is unsafe', async () => {
    const { runtime } = createSideEffectRuntime()
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      serializeProviderBuffer: vi.fn().mockResolvedValue({
        data: 'restored tui',
        cols: 80,
        rows: 24,
        seq: 903,
        source: 'headless',
        alternateScreen: true
      }),
      hasRendererSerializer: () => false
    })
    runtime.onPtyData('pty-tui', 'tui', 100)
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-tui',
      { value: 900, generation: 'continued' },
      0
    )

    await runtime.serializeTerminalBuffer('pty-tui')

    expect(runtime.isTerminalAlternateScreen('pty-tui')).toBe(true)
  })

  it('tracks live alternate-screen transitions after a provider snapshot', async () => {
    const { runtime } = createSideEffectRuntime()
    const serializeProviderBuffer = vi.fn().mockResolvedValue({
      data: 'restored tui',
      cols: 80,
      rows: 24,
      seq: 900,
      source: 'headless',
      alternateScreen: true
    })
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      serializeProviderBuffer,
      hasRendererSerializer: () => false
    })
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-tui',
      { value: 900, generation: 'continued' },
      0
    )
    await runtime.serializeTerminalBuffer('pty-tui')
    expect(runtime.isTerminalAlternateScreen('pty-tui')).toBe(true)

    runtime.onPtyData('pty-tui', '\x1b[?1049l', 100)
    expect(runtime.isTerminalAlternateScreen('pty-tui')).toBe(false)
    runtime.onPtyData('pty-tui', '\x1b[?1049h', 101)
    expect(runtime.isTerminalAlternateScreen('pty-tui')).toBe(true)
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

  it('translates reset provider snapshots without retaining the old title', async () => {
    const { runtime } = createSideEffectRuntime()
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-replaced',
      { value: 0, generation: 'reset' },
      0
    )
    runtime.onPtyData('pty-replaced', '\x1b]0;Old process\x07old', 100)
    const sequenceBeforeRespawn = runtime.getPtyOutputSequence('pty-replaced')
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      serializeProviderBuffer: vi.fn().mockResolvedValue({
        data: 'new process',
        cols: 80,
        rows: 24,
        seq: 'new process'.length,
        source: 'headless',
        lastTitle: 'New process'
      }),
      hasRendererSerializer: () => false
    })
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-replaced',
      { value: 0, generation: 'reset' },
      sequenceBeforeRespawn
    )

    await expect(runtime.serializeTerminalBuffer('pty-replaced')).resolves.toMatchObject({
      lastTitle: 'New process',
      seq: sequenceBeforeRespawn + 'new process'.length
    })
  })

  it('prefers the tracked title over the headless emulator lastTitle', async () => {
    const { runtime } = createSideEffectRuntime()
    syncSinglePty(runtime)

    runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07real output\r\n', 100)
    // Hook-driven idle frame lands only in main's tracker; the emulator never sees fabricated bytes (invariant 5).
    runtime.ingestSyntheticTitleFrame('pty-1', '\x1b]0;Codex ready\x07')

    const snapshot = await runtime.serializeMainTerminalBuffer('pty-1', { scrollbackRows: 10 })
    expect(snapshot?.source).toBe('headless')
    expect(snapshot?.lastTitle).toBe('Codex ready')
  })

  it('returns a title-only replay snapshot and never historical attention', () => {
    const { runtime } = createSideEffectRuntime()
    syncSinglePty(runtime)

    runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07\x07', 100)

    expect(runtime.getTerminalSideEffectSnapshot('pty-1')).toMatchObject({
      ptyId: 'pty-1',
      replay: true,
      facts: [{ kind: 'title', normalizedTitle: 'Codex working', rawTitle: 'Codex working' }]
    })
    expect(runtime.getTerminalSideEffectSnapshot('pty-unknown')).toBeNull()
  })

  it('keeps the cursor-agent literal in record-fallback snapshots only without a tracker title', () => {
    const { runtime } = createSideEffectRuntime()
    syncSinglePty(runtime)

    runtime.onPtyData('pty-1', 'plain output\n', 100)
    // Simulate a record title restored by a path that bypassed the tracker.
    const records = (
      runtime as unknown as {
        ptysById: Map<string, { lastOscTitle: string | null }>
      }
    ).ptysById
    records.get('pty-1')!.lastOscTitle = 'Cursor Agent'

    // Why: a hookless Cursor pane has no other identity to restore (#10258).
    expect(runtime.getTerminalSideEffectSnapshot('pty-1')).toMatchObject({
      facts: [{ kind: 'title', normalizedTitle: 'Cursor Agent', rawTitle: 'Cursor Agent' }]
    })

    // A synthesized Cursor title owns the pane; the bare literal must not replay over it.
    runtime.ingestSyntheticTitleFrame('pty-1', '\x1b]0;⠋ Cursor Agent\x07')

    expect(runtime.getTerminalSideEffectSnapshot('pty-1')).toMatchObject({
      facts: [{ kind: 'title', normalizedTitle: '⠋ Cursor Agent', rawTitle: '⠋ Cursor Agent' }]
    })
  })

  it('emits the chunk agentStatus events before its side-effect batch', () => {
    // Cross-channel contract order per chunk: status → titles → bell.
    const order: string[] = []
    const runtime = new OrcaRuntimeService(store, undefined, {
      onTerminalAgentStatus: () => order.push('agentStatus:set'),
      onTerminalSideEffects: () => order.push('pty:sideEffect')
    })
    syncSinglePty(runtime)

    runtime.onPtyData(
      'pty-1',
      '\x1b]9999;{"state":"working","agentType":"codex"}\x07\x1b]0;Codex working\x07\x07',
      100
    )

    expect(order).toEqual(['agentStatus:set', 'pty:sideEffect'])
  })

  it('still emits a throwing chunk’s facts under its own seq, not the next chunk’s', () => {
    const { runtime, batches } = createSideEffectRuntime()
    syncSinglePty(runtime)
    vi.spyOn(
      runtime as unknown as { applyTrackedPtyTitle: (ptyId: string, title: string) => boolean },
      'applyTrackedPtyTitle'
    ).mockImplementationOnce(() => {
      throw new Error('tracker boom')
    })

    const first = '\x1b]0;Codex working\x07'
    expect(() => runtime.onPtyData('pty-1', first, 100)).toThrow('tracker boom')
    runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)

    expect(batches).toHaveLength(2)
    expect(batches[0].seq).toBe(first.length)
    expect(batches[0].facts).toEqual([
      { kind: 'title', normalizedTitle: 'Codex working', rawTitle: 'Codex working' }
    ])
    // Next chunk's batch carries only its own facts: the throw aborted the first chunk's tracker pass, so no working state kept.
    expect(batches[1].seq).toBeGreaterThan(batches[0].seq)
    expect(batches[1].facts).toEqual([
      { kind: 'title', normalizedTitle: 'Codex done', rawTitle: 'Codex done' }
    ])
  })

  it('parses synthetic frames statelessly so ticks cannot corrupt the bell detector', () => {
    const { runtime, batches } = createSideEffectRuntime()
    syncSinglePty(runtime)

    runtime.onPtyData('pty-1', '\x1b]0;split ti', 100)
    // An 80ms spinner tick lands between the two halves of the real OSC.
    runtime.ingestSyntheticTitleFrame('pty-1', '\x1b]0;⠋ Cursor Agent\x07')
    // Continuation: this BEL terminates the real OSC — it is NOT a bell.
    runtime.onPtyData('pty-1', 'tle\x07', 101)
    // A later standalone BEL is a real bell and must not be swallowed.
    runtime.onPtyData('pty-1', 'ready\x07', 102)

    expect(batches.flatMap((batch) => batch.facts)).toEqual([
      { kind: 'title', normalizedTitle: '⠋ Cursor Agent', rawTitle: '⠋ Cursor Agent' },
      { kind: 'agent-working' },
      { kind: 'title', normalizedTitle: 'split title', rawTitle: 'split title' },
      { kind: 'bell' }
    ])
  })

  it('touches mobile snapshots once for decorative spinner ticks, again on idle', () => {
    const { runtime } = createSideEffectRuntime()
    syncSinglePty(runtime)
    const touchSpy = vi.spyOn(
      runtime as unknown as { touchMobileSessionSnapshotsForPty: (ptyId: string) => void },
      'touchMobileSessionSnapshotsForPty'
    )

    for (const frame of ['⠋', '⠙', '⠹', '⠸', '⠼']) {
      runtime.ingestSyntheticTitleFrame('pty-1', `\x1b]0;${frame} Cursor Agent\x07`)
    }
    // Five ticks with the same de-spinnered title: one snapshot fan-out.
    expect(touchSpy).toHaveBeenCalledTimes(1)

    runtime.ingestSyntheticTitleFrame('pty-1', '\x1b]0;Cursor ready\x07')
    expect(touchSpy).toHaveBeenCalledTimes(2)
    // Raw record titles still track every frame for worktree ps/mobile tabs.
    expect(
      (
        runtime as unknown as {
          ptysById: Map<string, { lastOscTitle: string | null }>
        }
      ).ptysById.get('pty-1')?.lastOscTitle
    ).toBe('Cursor ready')
  })

  it('seeds the lazily created tracker from the daemon-snapshot title', async () => {
    const { runtime, batches } = createSideEffectRuntime()
    const serializeBuffer = vi.fn().mockResolvedValue({
      data: 'restored scrollback\n',
      cols: 80,
      rows: 24,
      lastTitle: 'Codex working'
    })
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      serializeBuffer,
      hasRendererSerializer: () => true,
      getSize: () => ({ cols: 80, rows: 24 })
    })
    syncSinglePty(runtime)

    // First live chunk creates the tracker cold and kicks off hydration; the snapshot seed must land in that tracker.
    runtime.onPtyData('pty-1', 'plain output without a title\n', 100)
    await runtime.serializeMainTerminalBuffer('pty-1', { scrollbackRows: 10 })
    batches.length = 0

    runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)

    // Without the seed the tracker never saw 'working', so this idle title could not produce a completion fact.
    expect(batches.flatMap((batch) => batch.facts)).toContainEqual({
      kind: 'agent-idle',
      title: 'Codex done'
    })
  })
})
