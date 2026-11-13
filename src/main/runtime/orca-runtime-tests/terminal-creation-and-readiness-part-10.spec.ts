import { describe, expect, it, vi } from 'vitest'
import './runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import '../orca-runtime-test-mocks/setup.spec'
import '../rpc/dispatcher'
import '../rpc/methods/terminal/terminal'
import { store, syncSinglePty } from './orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('rejects a provider visible frame after live non-mode-switch output advances', async () => {
    type Snapshot = {
      data: string
      cols: number
      rows: number
      seq: number
      source: 'headless'
      alternateScreen: boolean
    }
    let resolveSnapshot!: (snapshot: Snapshot) => void
    const serializeProviderBuffer = vi.fn(
      () =>
        new Promise<Snapshot>((resolve) => {
          resolveSnapshot = resolve
        })
    )
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      serializeProviderBuffer,
      hasRendererSerializer: () => false
    })
    syncSinglePty(runtime)
    runtime.onPtyData('pty-1', 'shell history\r\n', 100)
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-1',
      { value: 900, generation: 'continued' },
      0
    )
    const [terminal] = (await runtime.listTerminals()).terminals

    const readPromise = runtime.readTerminal(terminal.handle)
    await vi.waitFor(() => expect(serializeProviderBuffer).toHaveBeenCalledOnce())
    runtime.onPtyData('pty-1', 'live progress\r\n', 101)
    resolveSnapshot({
      data: '\x1b[?1049h\x1b[2J\x1b[HStale Ready screen\r\n',
      cols: 80,
      rows: 24,
      seq: 900,
      source: 'headless',
      alternateScreen: true
    })

    const read = await readPromise
    expect(read.tail).toEqual(['shell history'])
    expect(read.tail.join('\n')).not.toContain('Stale Ready screen')
  })

  it('bounds a stuck provider snapshot and shares the timed-out request', async () => {
    vi.useFakeTimers()
    try {
      const serializeProviderBuffer = vi.fn(() => new Promise<never>(() => undefined))
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null,
        serializeProviderBuffer,
        hasRendererSerializer: () => false
      })
      syncSinglePty(runtime)
      runtime.onPtyData('pty-1', 'shell history\r\n', 100)
      runtime.synchronizePtyOutputSequenceFromProvider(
        'pty-1',
        { value: 900, generation: 'continued' },
        0
      )
      const [terminal] = (await runtime.listTerminals()).terminals

      const reads = Promise.all([
        runtime.readTerminal(terminal.handle),
        runtime.showTerminal(terminal.handle)
      ])
      await vi.advanceTimersByTimeAsync(750)
      const [read, shown] = await reads

      expect(read.tail).toEqual(['shell history'])
      expect(shown.preview).toBe('shell history')
      expect(serializeProviderBuffer).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('discards a provider frame when the PTY generation resets during capture', async () => {
    type Snapshot = {
      data: string
      cols: number
      rows: number
      seq: number
      source: 'headless'
      alternateScreen: boolean
    }
    let resolveSnapshot!: (snapshot: Snapshot) => void
    const serializeProviderBuffer = vi.fn(
      () =>
        new Promise<Snapshot>((resolve) => {
          resolveSnapshot = resolve
        })
    )
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      serializeProviderBuffer,
      hasRendererSerializer: () => false
    })
    syncSinglePty(runtime)
    runtime.onPtyData('pty-1', 'old shell\r\n', 100)
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-1',
      { value: 900, generation: 'continued' },
      0
    )
    const [terminal] = (await runtime.listTerminals()).terminals

    const readPromise = runtime.readTerminal(terminal.handle)
    await vi.waitFor(() => expect(serializeProviderBuffer).toHaveBeenCalledOnce())
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-1',
      { value: 0, generation: 'reset' },
      runtime.getPtyOutputSequence('pty-1')
    )
    resolveSnapshot({
      data: '\x1b[?1049hStale generation TUI\r\n',
      cols: 80,
      rows: 24,
      seq: 900,
      source: 'headless',
      alternateScreen: true
    })

    const read = await readPromise
    expect(read.tail.join('\n')).not.toContain('Stale generation TUI')
    expect(runtime.isTerminalAlternateScreen('pty-1')).toBe(false)
  })

  it('rejects a visible frame when its terminal handle changes during capture', async () => {
    type Snapshot = {
      data: string
      cols: number
      rows: number
      seq: number
      source: 'headless'
      alternateScreen: boolean
    }
    let resolveSnapshot!: (snapshot: Snapshot) => void
    const serializeProviderBuffer = vi.fn(
      () =>
        new Promise<Snapshot>((resolve) => {
          resolveSnapshot = resolve
        })
    )
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      serializeProviderBuffer,
      hasRendererSerializer: () => false
    })
    syncSinglePty(runtime)
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-1',
      { value: 900, generation: 'continued' },
      0
    )
    const [terminal] = (await runtime.listTerminals()).terminals

    const readPromise = runtime.readTerminal(terminal.handle)
    await vi.waitFor(() => expect(serializeProviderBuffer).toHaveBeenCalledOnce())
    syncSinglePty(runtime, 'pty-2')
    resolveSnapshot({
      data: '\x1b[?1049hWrong terminal frame\r\n',
      cols: 80,
      rows: 24,
      seq: 900,
      source: 'headless',
      alternateScreen: true
    })

    await expect(readPromise).rejects.toThrow('terminal_handle_stale')
  })

  it('separates composer draft text from rendered terminal output', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      hasRendererSerializer: () => false
    })
    syncSinglePty(runtime)
    runtime.onPtyData(
      'pty-1',
      '\x1b[?1049hBuild passed\r\n────────\r\n❯ \x1b[2mproceed with the release\r\n  and close the pull request\x1b[22m\x1b[1A\x1b[3G',
      100
    )
    const [terminal] = (await runtime.listTerminals()).terminals

    const read = await runtime.readTerminal(terminal.handle)

    expect(read).toMatchObject({
      source: 'screen',
      tail: ['Build passed', '────────', '❯'],
      draft: 'proceed with the release\nand close the pull request'
    })
  })

  it('does not use renderer visible-screen fallback for cursor transcript reads', async () => {
    const serializeBuffer = vi.fn().mockResolvedValue({
      data: 'Visible TUI\n',
      cols: 80,
      rows: 24
    })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      hasRendererSerializer: () => true,
      serializeBuffer
    })
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', '   \n', 100)

    const read = await runtime.readTerminal(terminal.handle, { cursor: 0 })

    expect(read.tail).toEqual([''])
    expect(serializeBuffer).not.toHaveBeenCalledWith('pty-1', {
      scrollbackRows: 0
    })
  })
})
