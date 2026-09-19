import { describe, expect, it, vi } from 'vitest'
import {
  OrcaRuntimeService,
  RpcDispatcher,
  TERMINAL_METHODS
} from '../orca-runtime-test-mocks.spec'
import { makeRpcRequest, store, syncSinglePty } from '../orca-runtime-test-fixtures.spec'

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

  it('rejects a full provider screen frame after live output advances', async () => {
    type Snapshot = {
      data: string
      scrollbackAnsi: string
      cols: number
      rows: number
      seq: number
      source: 'headless'
      alternateScreen: boolean
    }
    let resolveSnapshot!: (snapshot: Snapshot) => void
    const serializeProviderBuffer = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockImplementationOnce(
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

    const readPromise = runtime.readTerminal(terminal.handle, { screen: true })
    await vi.waitFor(() => expect(serializeProviderBuffer).toHaveBeenCalledTimes(2))
    runtime.onPtyData('pty-1', 'live progress\r\n', 101)
    resolveSnapshot({
      data: '\x1b[?1049h\x1b[2J\x1b[HStale full screen\r\n',
      scrollbackAnsi: '',
      cols: 80,
      rows: 24,
      seq: 900,
      source: 'headless',
      alternateScreen: true
    })

    const read = await readPromise
    expect(read.source).toBe('screen-unavailable')
    expect(read.tail.join('\n')).not.toContain('Stale full screen')
  })

  it('shares one provider snapshot between concurrent read and show calls', async () => {
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
    const showPromise = runtime.showTerminal(terminal.handle)
    await vi.waitFor(() => expect(serializeProviderBuffer).toHaveBeenCalledOnce())
    resolveSnapshot({
      data: '\x1b[?1049h\x1b[2J\x1b[HShared TUI frame\r\n',
      cols: 80,
      rows: 24,
      seq: 900,
      source: 'headless',
      alternateScreen: true
    })

    const [read, shown] = await Promise.all([readPromise, showPromise])
    expect(read.tail).toEqual(['Shared TUI frame'])
    expect(shown.preview).toBe('Shared TUI frame')
    expect(serializeProviderBuffer).toHaveBeenCalledOnce()
  })

  it('keeps cursor reads provider-free on restored alternate-screen PTYs', async () => {
    const serializeProviderBuffer = vi.fn()
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

    const read = await runtime.readTerminal(terminal.handle, { cursor: 0 })

    expect(read.tail).toEqual(['shell history'])
    expect(serializeProviderBuffer).not.toHaveBeenCalled()
  })

  it('backs off after a provider snapshot failure instead of retrying for show', async () => {
    const serializeProviderBuffer = vi.fn().mockRejectedValue(new Error('provider unavailable'))
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

    const read = await runtime.readTerminal(terminal.handle)
    const shown = await runtime.showTerminal(terminal.handle)

    expect(read.tail).toEqual(['shell history'])
    expect(shown.preview).toBe('shell history')
    expect(serializeProviderBuffer).toHaveBeenCalledOnce()
  })

  it('falls back once to a mounted renderer when a known alternate provider fails', async () => {
    const serializeProviderBuffer = vi
      .fn()
      .mockResolvedValueOnce({
        data: '\x1b[?1049h\x1b[2J\x1b[HProvider TUI\r\n',
        cols: 80,
        rows: 24,
        seq: 900,
        source: 'headless',
        alternateScreen: true
      })
      .mockRejectedValue(new Error('provider unavailable'))
    const serializeBuffer = vi.fn().mockResolvedValue({
      data: '\x1b[?1049h\x1b[2J\x1b[HRenderer TUI\r\n',
      cols: 80,
      rows: 24
    })
    let rendererMounted = false
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      serializeBuffer,
      serializeProviderBuffer,
      hasRendererSerializer: () => rendererMounted
    })
    syncSinglePty(runtime)
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-1',
      { value: 900, generation: 'continued' },
      0
    )
    const [terminal] = (await runtime.listTerminals()).terminals
    await expect(runtime.readTerminal(terminal.handle)).resolves.toMatchObject({
      tail: ['Provider TUI']
    })
    runtime.onPtyData('pty-1', 'new output', 100)
    rendererMounted = true

    const read = await runtime.readTerminal(terminal.handle)

    expect(read.tail).toEqual(['Renderer TUI'])
    expect(serializeProviderBuffer).toHaveBeenCalledTimes(2)
    expect(serializeBuffer).toHaveBeenCalledOnce()
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

  it('bounds provider visible frames for read and show responses', async () => {
    const visibleLines = [
      'skip-1',
      'skip-2',
      'A'.repeat(49),
      'B'.repeat(49),
      'C'.repeat(49),
      'D'.repeat(49),
      'E'.repeat(49),
      'F'.repeat(50)
    ]
    const expectedTail = visibleLines.slice(-6)
    const serializeProviderBuffer = vi.fn().mockResolvedValue({
      data: `\x1b[?1049h\x1b[2J\x1b[H${visibleLines.join('\r\n')}\r\n`,
      cols: 80,
      rows: 24,
      seq: 900,
      source: 'headless',
      alternateScreen: true
    })
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

    const read = await runtime.readTerminal(terminal.handle, { limit: 6 })
    const shown = await runtime.showTerminal(terminal.handle)

    expect(read.tail).toEqual(expectedTail)
    expect(read.returnedLineCount).toBe(6)
    expect(shown.preview).toBe(expectedTail.join('\n'))
    expect(shown.preview.length).toBe(300)
    expect(serializeProviderBuffer).toHaveBeenCalledOnce()
  })

  it('returns renderer visible screen lines through terminal.read RPC JSON result', async () => {
    const serializeBuffer = vi.fn().mockResolvedValue({
      data: '\x1b[?1049hClaude Code\r\nChecking files\r\nWaiting for input\r\n',
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
    runtime.onPtyData('pty-1', `${Array.from({ length: 3000 }, () => '').join('\n')}\n`, 100)
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      makeRpcRequest('terminal.read', { terminal: terminal.handle })
    )

    expect(response.ok).toBe(true)
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    expect(response.result).toMatchObject({
      terminal: {
        handle: terminal.handle,
        status: 'running',
        tail: ['Claude Code', 'Checking files', 'Waiting for input']
      }
    })
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

  it('keeps renderer-fallback composer drafts separate from terminal output', async () => {
    const serializeBuffer = vi.fn().mockResolvedValue({
      data: '\x1b[?1049hBuild passed\r\n────────\r\n❯ \x1b[2mproceed with the release\x1b[22m\x1b[3G',
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
    runtime.onPtyData('pty-1', `${Array.from({ length: 3000 }, () => '').join('\n')}\n`, 100)
    const [terminal] = (await runtime.listTerminals()).terminals

    const read = await runtime.readTerminal(terminal.handle)

    expect(read).toMatchObject({
      source: 'screen',
      tail: ['Build passed', '────────', '❯'],
      draft: 'proceed with the release'
    })
    expect(serializeBuffer).toHaveBeenCalledWith('pty-1', {
      scrollbackRows: 0
    })
  })

  it('separates composer drafts from provider-owned terminal screens', async () => {
    const serializeProviderBuffer = vi.fn().mockResolvedValue({
      data: '\x1b[?1049hBuild passed\r\n────────\r\n❯ \x1b[2mproceed with the release\x1b[22m\x1b[3G',
      cols: 80,
      rows: 24,
      seq: 900,
      source: 'headless',
      alternateScreen: true
    })
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

    const read = await runtime.readTerminal(terminal.handle)

    expect(read).toMatchObject({
      source: 'screen',
      tail: ['Build passed', '────────', '❯'],
      draft: 'proceed with the release'
    })
    expect(serializeProviderBuffer).toHaveBeenCalledOnce()
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

  it('does not use renderer visible-screen fallback for a short blank shell tail', async () => {
    const serializeBuffer = vi.fn().mockResolvedValue({
      data: 'shell prompt\n',
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
    runtime.onPtyData('pty-1', '\n\n', 100)

    const read = await runtime.readTerminal(terminal.handle)

    expect(read.tail).toEqual(['', ''])
    expect(serializeBuffer).not.toHaveBeenCalledWith('pty-1', {
      scrollbackRows: 0
    })
  })
})
