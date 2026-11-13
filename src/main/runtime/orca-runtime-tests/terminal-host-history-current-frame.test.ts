import { describe, expect, it, vi } from 'vitest'
import './runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import '../orca-runtime-test-mocks/setup.spec'
import '../rpc/dispatcher'
import '../rpc/methods/terminal/terminal'
import { store, syncSinglePty } from './orca-runtime-test-fixtures.spec'
import type { PtyProviderBufferSnapshot } from '../../providers/pty/provider-contract'
import { HeadlessEmulator } from '../../daemon/emulation/headless-emulator'
import type { RuntimeProviderSnapshotReadOptions } from '../terminal/output/provider-snapshot-read-options'

// CJ6: a host-owned current frame used to join an outstanding deep history read and fail with it.
describe('host-owned terminal current frame', () => {
  async function hostOwnedTerminal(mainRows: string) {
    // The daemon frame is current: it covers every byte the stream delivered.
    let frameSeq = 0
    const serializeProviderBuffer = vi.fn((_ptyId: string, opts?: { scrollbackRows?: number }) =>
      (opts?.scrollbackRows ?? 0) > 0
        ? new Promise<never>(() => {})
        : Promise.resolve({
            data: 'PROVIDER_SCREEN_ROW\r\n',
            cols: 80,
            rows: 24,
            seq: frameSeq,
            source: 'headless' as const,
            alternateScreen: false
          })
    )
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      serializeProviderBuffer,
      hasRendererSerializer: () => false,
      getTerminalHistoryAuthority: () => ({ owner: 'host', incarnationId: 'incarnation-1' })
    })
    syncSinglePty(runtime)
    runtime.onPtyData('pty-1', mainRows, 100)
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-1',
      { value: 900, generation: 'continued' },
      0
    )
    frameSeq = runtime.getPtyOutputSequence('pty-1')
    const [terminal] = (await runtime.listTerminals()).terminals
    // A retained-history read that never answers.
    void runtime.serializeMainTerminalBuffer('pty-1', { scrollbackRows: 1000 })
    await vi.waitFor(() => expect(serializeProviderBuffer).toHaveBeenCalled())
    return { runtime, handle: terminal.handle }
  }

  it('answers --screen from the daemon frame, not main rows, while a deep read stalls', async () => {
    const { runtime, handle } = await hostOwnedTerminal('MAIN_ONLY_ROW\r\n')

    const read = await runtime.readTerminal(handle, { screen: true })

    expect(read.source).not.toBe('screen-unavailable')
    expect(read.tail.join('\n')).toContain('PROVIDER_SCREEN_ROW')
    expect(read.tail.join('\n')).not.toContain('MAIN_ONLY_ROW')
  })

  it('fills a blank stream read from the daemon frame while a deep read stalls', async () => {
    const { runtime, handle } = await hostOwnedTerminal(' \r\n'.repeat(200))

    const read = await runtime.readTerminal(handle)

    expect(read.tail.join('\n')).toContain('PROVIDER_SCREEN_ROW')
  })
})

// GH1286: a frame taken for one grid, or one lifecycle, used to stay current or be published later.
describe('terminal frame across a grid change or lifecycle reset', () => {
  type Gate<T> = { settled: boolean; resolve: (value: T | null) => void }
  type RendererFrame = { data: string; cols: number; rows: number }
  const probeOptions = { timeoutMs: 100, retireOnTimeout: true, visibleScreenOnly: true }

  async function terminalAt(
    cols: number,
    rows: number,
    owner: 'host' | 'provider',
    opts: { renderer?: boolean } = {}
  ) {
    let grid = { cols, rows }
    // Set before any release: a continuation that asks the provider during cleanup is answered at once.
    let cleaning = false
    let openReads = 0
    // Registered only when a case arms it, so setup output does not start a renderer hydration.
    let rendererRegistered = false
    const frames: Gate<PtyProviderBufferSnapshot>[] = []
    const deep: Gate<PtyProviderBufferSnapshot>[] = []
    const renders: Gate<RendererFrame>[] = []
    const issued: Promise<unknown>[] = []
    function hold<T>(gates: Gate<T>[]): Promise<T | null> {
      const held = Promise.withResolvers<T | null>()
      const gate: Gate<T> = {
        settled: false,
        resolve: (value) => {
          gate.settled = true
          held.resolve(value)
        }
      }
      gates.push(gate)
      if (cleaning) {
        gate.resolve(null)
      }
      return held.promise
    }
    function track<T>(operation: Promise<T>): Promise<T> {
      openReads += 1
      issued.push(
        operation.then(
          () => (openReads -= 1),
          () => (openReads -= 1)
        )
      )
      return operation
    }
    const serializeProviderBuffer = vi.fn((_ptyId: string, opts?: { scrollbackRows?: number }) =>
      (opts?.scrollbackRows ?? 0) > 0 ? hold(deep) : hold(frames)
    )
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      getSize: () => grid,
      serializeProviderBuffer,
      hasRendererSerializer: () => rendererRegistered,
      ...(opts.renderer ? { serializeBuffer: () => hold(renders) } : {}),
      ...(owner === 'host'
        ? {
            getTerminalHistoryAuthority: () => ({
              owner: 'host' as const,
              incarnationId: 'incarnation-1'
            })
          }
        : {})
    })
    syncSinglePty(runtime)
    runtime.onPtyData('pty-1', 'MAIN_ONLY_ROW\r\n', 100)
    if (owner === 'provider') {
      // A restored terminal whose model may miss bytes: its screen is the provider's frame.
      runtime.synchronizePtyOutputSequenceFromProvider(
        'pty-1',
        { value: 900, generation: 'continued' },
        0
      )
    }
    const [terminal] = (await runtime.listTerminals()).terminals
    return {
      frames,
      deep,
      renders,
      // The provider's frame at the current sequence, drawn for the given grid.
      frame: (
        row: string,
        frameCols: number,
        frameRows: number,
        alternateScreen = owner === 'provider'
      ): PtyProviderBufferSnapshot => ({
        data: row ? `${row}\r\n` : '',
        cols: frameCols,
        rows: frameRows,
        seq: runtime.getPtyOutputSequence('pty-1'),
        source: 'headless',
        alternateScreen
      }),
      output: (data: string) => runtime.onPtyData('pty-1', data, Date.now()),
      screenMode: () => runtime.isTerminalAlternateScreen('pty-1'),
      read: (first: { screen?: boolean }, options: RuntimeProviderSnapshotReadOptions = {}) =>
        track(runtime.readTerminal(terminal.handle, first, options)),
      screen: (): Promise<string> =>
        track(runtime.readTerminal(terminal.handle, { screen: true })).then((result) =>
          result.tail.join('\n')
        ),
      preview: (): Promise<string> =>
        track(runtime.showTerminal(terminal.handle)).then((shown) => shown.preview),
      // A deep provider consumer: hidden-output recovery reads restored history from the provider.
      deepRead: () =>
        track(runtime.serializeHiddenOutputRecoveryBuffer('pty-1', { scrollbackRows: 1000 })),
      registerRenderer: () => {
        rendererRegistered = opts.renderer === true
      },
      resize: (nextCols: number, nextRows: number) => {
        grid = { cols: nextCols, rows: nextRows }
        runtime.onExternalPtyResize('pty-1', nextCols, nextRows)
      },
      reset: () =>
        runtime.synchronizePtyOutputSequenceFromProvider('pty-1', {
          value: 5,
          generation: 'reset'
        }),
      outstanding: () => ({
        gates: [...frames, ...deep, ...renders].filter((gate) => !gate.settled).length,
        reads: openReads
      }),
      // Pass or fail: enter cleanup first, then release every held answer and settle every read.
      cleanup: async () => {
        cleaning = true
        for (const gate of [...frames, ...deep, ...renders]) {
          gate.resolve(null)
        }
        await Promise.all(issued)
      }
    }
  }

  /** Controlled time: provider waits and caller deadlines advance only when the test says so. */
  async function advance(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms)
  }

  function settledFlag(operation: Promise<unknown>): () => boolean {
    let settled = false
    void operation.then(
      () => (settled = true),
      () => (settled = true)
    )
    return () => settled
  }

  it('takes a new frame after a resize instead of the cached old-grid one', async () => {
    const t = await terminalAt(80, 24, 'host')
    try {
      const first = t.screen()
      await vi.waitFor(() => expect(t.frames).toHaveLength(1))
      t.frames[0]!.resolve(t.frame('GRID_80_ROW', 80, 24))
      expect(await first).toContain('GRID_80_ROW')

      t.resize(40, 10)
      const second = t.screen()
      await vi.waitFor(() => expect(t.frames).toHaveLength(2))
      t.frames[1]!.resolve(t.frame('GRID_40_ROW', 40, 10))
      const read = await second

      expect(read).toContain('GRID_40_ROW')
      expect(read).not.toContain('GRID_80_ROW')
    } finally {
      await t.cleanup()
    }
  })

  it.each(['host', 'provider'] as const)(
    'never returns or keeps a %s frame taken before the grid changed and came back',
    async (owner) => {
      const t = await terminalAt(80, 25, owner)
      try {
        const late = t.screen()
        await vi.waitFor(() => expect(t.frames).toHaveLength(1))
        t.resize(40, 10)
        t.resize(80, 25)
        const successor = t.screen()
        await vi.waitFor(() => expect(t.frames).toHaveLength(2))
        t.frames[1]!.resolve(t.frame('SUCCESSOR_ROW', 80, 25))
        expect(await successor).toContain('SUCCESSOR_ROW')

        // The retired read neither returns its frame nor asks again for its own fallback.
        t.frames[0]!.resolve(t.frame('LATE_ROW', 80, 25))
        expect(await late).not.toContain('LATE_ROW')
        const after = await t.screen()
        expect(after).toContain('SUCCESSOR_ROW')
        expect(after).not.toContain('LATE_ROW')
        expect(t.frames).toHaveLength(2)
      } finally {
        await t.cleanup()
      }
    }
  )

  // HS-C1: the public screen's own fallback used to return a frame it acquired before the resize.
  it('never returns a positive fallback acquired before the grid changed and came back', async () => {
    const t = await terminalAt(80, 25, 'provider')
    try {
      const late = t.screen()
      await vi.waitFor(() => expect(t.frames).toHaveLength(1))
      t.frames[0]!.resolve(null)
      // The fallback is actually acquired, and held, before the grid changes.
      await vi.waitFor(() => expect(t.frames).toHaveLength(2))
      t.resize(40, 10)
      t.resize(80, 25)
      const successor = t.screen()
      await vi.waitFor(() => expect(t.frames).toHaveLength(3))
      t.frames[2]!.resolve(t.frame('SUCCESSOR_ROW', 80, 25))
      expect(await successor).toContain('SUCCESSOR_ROW')

      // A's older normal-screen answer must not change the mode later reads select their source by.
      t.frames[1]!.resolve(t.frame('LATE_ROW', 80, 25, false))
      expect(await late).not.toContain('LATE_ROW')
      const after = await t.screen()
      expect(after).toContain('SUCCESSOR_ROW')
      expect(after).not.toContain('LATE_ROW')
      expect(t.frames).toHaveLength(3)
    } finally {
      await t.cleanup()
    }
  })

  // HS-P1: each public reader used to take, and parse, its own fallback frame while deep D was held.
  // Required scaling contract: one primary and one fallback capture, and one parse of the frame they
  // need, whatever the number of readers. Counted at the supported parser, which keeps parsing.
  it.each([12, 120])(
    'shares one primary, one fallback and one parse across %i public screen readers',
    async (readers) => {
      const t = await terminalAt(80, 25, 'provider')
      const parses = vi.spyOn(HeadlessEmulator.prototype, 'write')
      try {
        const deepRead = t.deepRead()
        await vi.waitFor(() => expect(t.deep).toHaveLength(1))
        t.resize(40, 10)
        const reads = Array.from({ length: readers }, () => t.screen())
        await vi.waitFor(() => expect(t.frames).toHaveLength(1))
        t.frames[0]!.resolve(null)
        await vi.waitFor(() => expect(t.frames).toHaveLength(2))
        t.frames[1]!.resolve(t.frame('COHORT_ROW', 40, 10))

        for (const read of await Promise.all(reads)) {
          expect(read).toContain('COHORT_ROW')
        }
        expect(t.frames).toHaveLength(2)
        expect(t.deep).toHaveLength(1)
        expect(parses.mock.calls.filter(([data]) => data.includes('COHORT_ROW'))).toHaveLength(1)
        // Deep D still serves its own reader.
        t.deep[0]!.resolve(t.frame('DEEP_ROW', 40, 10))
        expect((await deepRead)?.data).toContain('DEEP_ROW')
      } finally {
        parses.mockRestore()
        await t.cleanup()
      }
    }
  )

  // The wait probe's real shapes: each joins work already acquired and ends at its own deadline.
  it('ends a trusted-screen probe at its own deadline while the shared fallback is held', async () => {
    const t = await terminalAt(80, 25, 'provider')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const long = t.screen()
      await advance(0)
      expect(t.frames).toHaveLength(1)
      t.frames[0]!.resolve(null)
      await advance(0)
      expect(t.frames).toHaveLength(2)

      const short = t.read({ screen: true }, probeOptions)
      const shortSettled = settledFlag(short)
      await advance(99)
      expect(shortSettled()).toBe(false)
      await advance(1)
      expect(shortSettled()).toBe(true)
      expect((await short).source).toBe('screen-unavailable')
      expect(t.frames).toHaveLength(2)

      t.frames[1]!.resolve(t.frame('PROBE_ROW', 80, 25))
      expect(await long).toContain('PROBE_ROW')
      expect(await t.screen()).toContain('PROBE_ROW')
      expect(t.frames).toHaveLength(2)
    } finally {
      vi.useRealTimers()
      await t.cleanup()
    }
  })

  it('ends a stream probe at its own deadline without throttling a later preview', async () => {
    const t = await terminalAt(80, 25, 'provider')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const long = t.screen()
      await advance(0)
      expect(t.frames).toHaveLength(1)

      const short = t.read({}, probeOptions)
      const shortSettled = settledFlag(short)
      await advance(99)
      expect(shortSettled()).toBe(false)
      await advance(1)
      expect(shortSettled()).toBe(true)
      expect((await short).tail.join('\n')).toContain('MAIN_ONLY_ROW')
      expect(t.frames).toHaveLength(1)

      // The probe's short deadline opened no retry window: a primary preview still waits for the frame.
      const preview = t.preview()
      const previewSettled = settledFlag(preview)
      await advance(0)
      expect(previewSettled()).toBe(false)
      t.frames[0]!.resolve(t.frame('PROBE_ROW', 80, 25))
      expect(await long).toContain('PROBE_ROW')
      expect(await preview).toContain('PROBE_ROW')
      expect(t.frames).toHaveLength(1)
    } finally {
      vi.useRealTimers()
      await t.cleanup()
    }
  })

  // The primary retry gate is a caller policy: it never ends the shared capture a longer read awaits.
  it('gates primary reads after a primary wait expires, then rejoins the same held capture', async () => {
    const t = await terminalAt(80, 25, 'provider')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const long = t.screen()
      await advance(0)
      expect(t.frames).toHaveLength(1)
      const expiring = t.read({})
      await advance(750)
      expect((await expiring).tail.join('\n')).toContain('MAIN_ONLY_ROW')

      // Inside the retry window a primary read answers at once, with no wait and no capture.
      const gated = t.read({})
      const gatedSettled = settledFlag(gated)
      await advance(0)
      expect(gatedSettled()).toBe(true)
      expect((await gated).tail.join('\n')).toContain('MAIN_ONLY_ROW')
      expect(t.frames).toHaveLength(1)

      // After the window the same held capture is joined again, within the caller's own bound.
      await advance(1_000)
      const rejoined = t.read({})
      const rejoinedSettled = settledFlag(rejoined)
      await advance(0)
      expect(rejoinedSettled()).toBe(false)
      t.frames[0]!.resolve(t.frame('GATED_ROW', 80, 25))
      expect(await long).toContain('GATED_ROW')
      expect((await rejoined).tail.join('\n')).toContain('GATED_ROW')
      expect(t.frames).toHaveLength(1)
    } finally {
      vi.useRealTimers()
      await t.cleanup()
    }
  })

  // FA-C2: a supplied deadline used to restart at the renderer fallback after the primary spent it.
  it('ends a stream probe at its own deadline across the primary and the renderer', async () => {
    const t = await terminalAt(80, 25, 'provider', { renderer: true })
    try {
      // A known alternate screen whose published frame later output has outdated.
      const first = t.screen()
      await vi.waitFor(() => expect(t.frames).toHaveLength(1))
      t.frames[0]!.resolve(t.frame('FIRST_ROW', 80, 25))
      expect(await first).toContain('FIRST_ROW')
      t.output('MORE_OUTPUT\r\n')
      t.registerRenderer()
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

      const probe = t.read({}, probeOptions)
      const probeSettled = settledFlag(probe)
      await advance(0)
      expect(t.frames).toHaveLength(2)
      await advance(90)
      t.frames[1]!.resolve(null)
      await advance(0)
      // The renderer fallback is actually reached, then held.
      expect(t.renders).toHaveLength(1)
      await advance(9)
      expect(probeSettled()).toBe(false)
      await advance(1)
      expect(probeSettled()).toBe(true)
      expect((await probe).tail.join('\n')).toContain('MORE_OUTPUT')
    } finally {
      vi.useRealTimers()
      await t.cleanup()
    }
  })

  // FO-P1: a settled frame used to count as leave for the fallback to capture and parse again.
  it('reuses a settled frame instead of capturing again when it does not apply', async () => {
    const t = await terminalAt(80, 25, 'provider')
    const parses = vi.spyOn(HeadlessEmulator.prototype, 'write')
    try {
      const read = t.screen()
      await vi.waitFor(() => expect(t.frames).toHaveLength(1))
      // A positive frame drawn for another grid: not applicable, and not an actual null either.
      t.frames[0]!.resolve(t.frame('WRONG_GRID_ROW', 40, 10))
      expect(await read).not.toContain('WRONG_GRID_ROW')
      expect(t.frames).toHaveLength(1)
      expect(parses.mock.calls.filter(([data]) => data.includes('WRONG_GRID_ROW'))).toHaveLength(1)
    } finally {
      parses.mockRestore()
      await t.cleanup()
    }
  })

  // FO-C2: a late frame that did not apply used to clear the retry window it arrived inside.
  it('keeps the retry window when a late frame for another grid arrives inside it', async () => {
    const t = await terminalAt(80, 25, 'provider')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const expiring = t.read({})
      await advance(0)
      expect(t.frames).toHaveLength(1)
      await advance(750)
      expect((await expiring).tail.join('\n')).toContain('MAIN_ONLY_ROW')
      await advance(50)
      t.frames[0]!.resolve(t.frame('WRONG_GRID_ROW', 40, 10))
      await advance(0)

      // Still inside the window: a primary preview answers at once, with no wait and no capture.
      const preview = t.preview()
      const previewSettled = settledFlag(preview)
      await advance(0)
      expect(previewSettled()).toBe(true)
      expect(await preview).not.toContain('WRONG_GRID_ROW')
      expect(t.frames).toHaveLength(1)
    } finally {
      vi.useRealTimers()
      await t.cleanup()
    }
  })

  // MML-PRJ-ACTUAL-NULL: a primary's actual null used to answer every later primary caller on the
  // read, so one arriving after the retry window missed the fallback frame that was still coming.
  it('lets a primary caller after the retry window join the pending fallback frame', async () => {
    const t = await terminalAt(80, 25, 'provider')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const long = t.screen()
      await advance(0)
      expect(t.frames).toHaveLength(1)
      t.frames[0]!.resolve(null)
      await advance(0)
      expect(t.frames).toHaveLength(2)

      await advance(1_500)
      const preview = t.preview()
      const previewSettled = settledFlag(preview)
      await advance(0)
      expect(previewSettled()).toBe(false)
      expect(t.frames).toHaveLength(2)

      await advance(500)
      t.frames[1]!.resolve(t.frame('POST_GATE_FRAME', 80, 25))
      expect(await long).toContain('POST_GATE_FRAME')
      expect(await preview).toContain('POST_GATE_FRAME')
      expect(t.frames).toHaveLength(2)
    } finally {
      vi.useRealTimers()
      await t.cleanup()
    }
  })

  // HS-C1 (adopted capture): a deep answer a superseded visible read had adopted used to set the
  // screen mode after a newer accepted frame. The provider's switch bytes are not yet delivered.
  it('never lets an older adopted deep answer change the mode of an accepted newer frame', async () => {
    const t = await terminalAt(80, 25, 'provider')
    const parses = vi.spyOn(HeadlessEmulator.prototype, 'write')
    try {
      const deepRead = t.deepRead()
      await vi.waitFor(() => expect(t.deep).toHaveLength(1))
      // D's complete normal-screen cut: its history marker sits more than a screen above the end.
      const history = Array.from({ length: 30 }, (_, index) => `HISTORY_${index}`)
      const deepAnswer = t.frame(['DEEP_HISTORY_ROW', ...history].join('\r\n'), 80, 25, false)
      // Let the public read pass its structured-worker await before changing the grid.
      const late = t.screen()
      const lateSettled = settledFlag(late)
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(lateSettled()).toBe(false)
      expect(t.frames).toHaveLength(0)
      expect(t.deep).toHaveLength(1)
      t.resize(40, 10)
      t.resize(80, 25)
      t.output('PROMPT$ ')
      const successor = t.screen()
      await vi.waitFor(() => expect(t.frames).toHaveLength(1))
      t.frames[0]!.resolve(t.frame('SUCCESSOR_ROW', 80, 25, true))
      expect(await successor).toContain('SUCCESSOR_ROW')

      t.deep[0]!.resolve(deepAnswer)
      const recovered = await deepRead
      expect(recovered?.data).toContain('DEEP_HISTORY_ROW')
      expect(recovered?.data).toContain('HISTORY_29')
      const lateRows = await late
      expect(lateRows).not.toContain('DEEP_HISTORY_ROW')
      expect(lateRows).not.toContain('HISTORY_29')
      const after = await t.screen()
      expect(after).toContain('SUCCESSOR_ROW')
      expect(after).not.toContain('MAIN_ONLY_ROW')
      // A never took a capture of its own, and B's frame was neither retaken nor reparsed.
      expect(t.frames).toHaveLength(1)
      expect(parses.mock.calls.filter(([data]) => data.includes('SUCCESSOR_ROW'))).toHaveLength(1)
    } finally {
      parses.mockRestore()
      await t.cleanup()
    }
  })

  it('lets a deep answer set the screen mode first, and a later deep cut update it', async () => {
    const t = await terminalAt(80, 25, 'provider')
    try {
      const first = t.deepRead()
      await vi.waitFor(() => expect(t.deep).toHaveLength(1))
      t.deep[0]!.resolve(t.frame('DEEP_ALT_ROW', 80, 25, true))
      expect((await first)?.data).toContain('DEEP_ALT_ROW')
      expect(t.screenMode()).toBe(true)

      const visible = t.screen()
      await vi.waitFor(() => expect(t.frames).toHaveLength(1))
      t.frames[0]!.resolve(t.frame('VISIBLE_ROW', 80, 25, true))
      expect(await visible).toContain('VISIBLE_ROW')
      // A deep cut taken after more output is later than the accepted frame, so its mode applies.
      t.output('LATER_OUTPUT\r\n')
      const second = t.deepRead()
      await vi.waitFor(() => expect(t.deep).toHaveLength(2))
      t.deep[1]!.resolve(t.frame('LATER_DEEP_ROW', 80, 25, false))
      expect((await second)?.data).toContain('LATER_DEEP_ROW')
      expect(t.screenMode()).toBe(false)
    } finally {
      await t.cleanup()
    }
  })

  // FA-C1: a preview's renderer fallback used to return rows taken before the grid changed and came back.
  it('never returns renderer rows taken before the grid changed and came back', async () => {
    const t = await terminalAt(80, 25, 'provider', { renderer: true })
    try {
      t.registerRenderer()
      const late = t.preview()
      await vi.waitFor(() => expect(t.frames).toHaveLength(1))
      t.frames[0]!.resolve(t.frame('', 80, 25))
      await vi.waitFor(() => expect(t.renders).toHaveLength(1))
      t.resize(40, 10)
      t.resize(80, 25)
      const successor = t.screen()
      await vi.waitFor(() => expect(t.frames).toHaveLength(2))
      t.frames[1]!.resolve(t.frame('SUCCESSOR_ROW', 80, 25))
      expect(await successor).toContain('SUCCESSOR_ROW')

      t.renders[0]!.resolve({ data: 'LATE_RENDER_ROW\r\n', cols: 80, rows: 25 })
      expect(await late).not.toContain('LATE_RENDER_ROW')
      expect(await t.preview()).toContain('SUCCESSOR_ROW')
    } finally {
      await t.cleanup()
    }
  })

  it('asks the replacement process at once after a frame read of the old one settles', async () => {
    const t = await terminalAt(80, 24, 'host')
    try {
      const late = t.screen()
      await vi.waitFor(() => expect(t.frames).toHaveLength(1))
      t.reset()
      t.frames[0]!.resolve(t.frame('OLD_PROCESS_ROW', 80, 24))
      expect(await late).not.toContain('OLD_PROCESS_ROW')

      const replacement = t.screen()
      await vi.waitFor(() => expect(t.frames).toHaveLength(2))
      t.frames[1]!.resolve(t.frame('NEW_PROCESS_ROW', 80, 24))
      expect(await replacement).toContain('NEW_PROCESS_ROW')
    } finally {
      await t.cleanup()
    }
  })

  // HS-C3: an early failure must survive cleanup, and cleanup must leave no held work behind,
  // including a request a released continuation makes while cleanup runs.
  it('keeps an early failure and leaves no held provider work behind', async () => {
    const t = await terminalAt(80, 25, 'provider')
    const run = async (): Promise<void> => {
      try {
        void t.screen()
        await vi.waitFor(() => expect(t.frames).toHaveLength(1))
        void t.deepRead()
        await vi.waitFor(() => expect(t.deep).toHaveLength(1))
        throw new Error('EXPECTED_EARLY_FAILURE')
      } finally {
        await t.cleanup()
      }
    }

    await expect(run()).rejects.toThrow('EXPECTED_EARLY_FAILURE')
    // Releasing the primary null sent the read to its fallback, which asked during cleanup.
    expect(t.frames).toHaveLength(2)
    expect(t.outstanding()).toEqual({ gates: 0, reads: 0 })
  })
})
