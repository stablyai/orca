import { describe, expect, it, vi } from 'vitest'
import './runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import '../orca-runtime-test-mocks/setup.spec'
import '../rpc/dispatcher'
import '../rpc/methods/terminal/terminal'
import { store, syncSinglePty } from './orca-runtime-test-fixtures.spec'
import type { PtyProviderBufferSnapshot } from '../../providers/pty-provider-contract'

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
  async function terminalAt(cols: number, rows: number, owner: 'host' | 'provider') {
    let grid = { cols, rows }
    const frames: PromiseWithResolvers<PtyProviderBufferSnapshot | null>[] = []
    const issued: Promise<unknown>[] = []
    const serializeProviderBuffer = vi.fn((_ptyId: string, opts?: { scrollbackRows?: number }) => {
      if ((opts?.scrollbackRows ?? 0) > 0) {
        return new Promise<never>(() => {})
      }
      const frame = Promise.withResolvers<PtyProviderBufferSnapshot | null>()
      frames.push(frame)
      return frame.promise
    })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      getSize: () => grid,
      serializeProviderBuffer,
      hasRendererSerializer: () => false,
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
      // The provider's frame at the current sequence, drawn for the given grid.
      frame: (row: string, frameCols: number, frameRows: number) => ({
        data: `${row}\r\n`,
        cols: frameCols,
        rows: frameRows,
        seq: runtime.getPtyOutputSequence('pty-1'),
        source: 'headless' as const,
        alternateScreen: owner === 'provider'
      }),
      screen: (): Promise<string> => {
        const read = runtime
          .readTerminal(terminal.handle, { screen: true })
          .then((result) => result.tail.join('\n'))
        issued.push(read.catch(() => {}))
        return read
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
      // Every held provider answer is released and every issued read settles, pass or fail.
      settle: async () => {
        for (const frame of frames) {
          frame.resolve(null)
        }
        await Promise.all(issued)
      }
    }
  }

  it('takes a new frame after a resize instead of the cached old-grid one', async () => {
    const { frames, frame, screen, resize, settle } = await terminalAt(80, 24, 'host')
    try {
      const first = screen()
      await vi.waitFor(() => expect(frames).toHaveLength(1))
      frames[0]!.resolve(frame('GRID_80_ROW', 80, 24))
      expect(await first).toContain('GRID_80_ROW')

      resize(40, 10)
      const second = screen()
      await vi.waitFor(() => expect(frames).toHaveLength(2))
      frames[1]!.resolve(frame('GRID_40_ROW', 40, 10))
      const read = await second

      expect(read).toContain('GRID_40_ROW')
      expect(read).not.toContain('GRID_80_ROW')
    } finally {
      await settle()
    }
  })

  it.each(['host', 'provider'] as const)(
    'never returns or keeps a %s frame taken before the grid changed and came back',
    async (owner) => {
      const { frames, frame, screen, resize, settle } = await terminalAt(80, 25, owner)
      try {
        const late = screen()
        await vi.waitFor(() => expect(frames).toHaveLength(1))
        resize(40, 10)
        resize(80, 25)
        const successor = screen()
        await vi.waitFor(() => expect(frames).toHaveLength(2))
        frames[1]!.resolve(frame('SUCCESSOR_ROW', 80, 25))
        expect(await successor).toContain('SUCCESSOR_ROW')

        frames[0]!.resolve(frame('LATE_ROW', 80, 25))
        if (owner === 'provider') {
          // Its frame refused, the late read's own screen fallback asks afresh; it gets nothing.
          await vi.waitFor(() => expect(frames).toHaveLength(3))
          frames[2]!.resolve(null)
        }
        expect(await late).not.toContain('LATE_ROW')
        const issuedBeforeAfter = frames.length
        const after = await screen()
        expect(after).toContain('SUCCESSOR_ROW')
        expect(after).not.toContain('LATE_ROW')
        // Served from the successor's frame, with no new provider call.
        expect(frames).toHaveLength(issuedBeforeAfter)
      } finally {
        await settle()
      }
    }
  )

  it('asks the replacement process at once after a frame read of the old one settles', async () => {
    const { frames, frame, screen, reset, settle } = await terminalAt(80, 24, 'host')
    try {
      const late = screen()
      await vi.waitFor(() => expect(frames).toHaveLength(1))
      reset()
      frames[0]!.resolve(frame('OLD_PROCESS_ROW', 80, 24))
      expect(await late).not.toContain('OLD_PROCESS_ROW')

      const replacement = screen()
      await vi.waitFor(() => expect(frames).toHaveLength(2))
      frames[1]!.resolve(frame('NEW_PROCESS_ROW', 80, 24))
      expect(await replacement).toContain('NEW_PROCESS_ROW')
    } finally {
      await settle()
    }
  })
})
