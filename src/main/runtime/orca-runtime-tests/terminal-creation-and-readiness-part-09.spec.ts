import { describe, expect, it, vi } from 'vitest'
import './runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'

import '../../../shared/terminal/protocol/input-modes/terminal-kitty-keyboard-mode-tracker'
import { store, syncSinglePty } from './orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('clears terminal scrollback through the PTY controller and headless buffer', async () => {
    const clearBuffer = vi.fn().mockResolvedValue(undefined)
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      clearBuffer
    })
    syncSinglePty(runtime, 'pty-1')

    runtime.onPtyData(
      'pty-1',
      `${Array.from({ length: 20 }, (_, i) => `line-${i}`).join('\n')}\n`,
      123
    )
    const [terminal] = (await runtime.listTerminals()).terminals
    // Where a phone viewing this terminal stands before the clear.
    const { ring } = runtime.retainPublishedTerminalOutput('pty-1')
    const phonePosition = ring.pointAt(runtime.getPtyOutputSequence('pty-1'))

    await expect(runtime.clearTerminalBuffer(terminal.handle)).resolves.toEqual({
      handle: terminal.handle,
      cleared: true
    })

    expect(clearBuffer).toHaveBeenCalledWith('pty-1')
    const snapshot = await runtime.serializeTerminalBuffer('pty-1', { scrollbackRows: 1000 })
    expect(snapshot?.data).not.toContain('line-0')
    // The phone can't resume onto the cleared scrollback; it gets the snapshot above.
    expect(ring.covers(phonePosition)).toBe(false)
  })

  it('resets input modes through the PTY controller and the headless model', async () => {
    const resetInputModes = vi.fn().mockResolvedValue(undefined)
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      resetInputModes
    })
    syncSinglePty(runtime, 'pty-1')
    // An app armed these and crashed with no command end.
    runtime.onPtyData('pty-1', 'prompt$ app\r\n\x1b[>31u\x1b[?1000h\x1b[?2004h', 123)
    const [terminal] = (await runtime.listTerminals()).terminals
    const armed = await runtime.serializeTerminalBuffer('pty-1')
    expect(armed?.kittyKeyboardFlags).toBe(31)

    await expect(runtime.resetTerminalInputModes(terminal.handle)).resolves.toEqual({
      handle: terminal.handle,
      reset: true
    })

    expect(resetInputModes).toHaveBeenCalledWith('pty-1')
    const snapshot = await runtime.serializeTerminalBuffer('pty-1')
    expect(snapshot?.kittyKeyboardFlags).toBe(0)
    expect(snapshot?.data).not.toContain('\x1b[?1000h')
    expect(snapshot?.data).not.toContain('\x1b[?2004h')
  })

  it('keeps partial-line output readable across cursor-based pagination', async () => {
    const runtime = new OrcaRuntimeService(store)

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Claude',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', 'hel', 100)

    const firstRead = await runtime.readTerminal(terminal.handle)
    expect(firstRead.tail).toEqual(['hel'])
    expect(firstRead.nextCursor).toBe('0')

    runtime.onPtyData('pty-1', 'lo', 101)

    // Exclude partial lines from cursor reads or the completed line repeats them.
    const secondRead = await runtime.readTerminal(terminal.handle, {
      cursor: Number(firstRead.nextCursor)
    })
    expect(secondRead.tail).toEqual([])
    expect(secondRead.nextCursor).toBe('0')

    runtime.onPtyData('pty-1', '\nworld\n', 102)

    const thirdRead = await runtime.readTerminal(terminal.handle, {
      cursor: Number(secondRead.nextCursor)
    })
    expect(thirdRead.tail).toEqual(['hello', 'world'])
    expect(thirdRead.nextCursor).toBe('2')
  })

  it.each([
    {
      name: 'live exit wins over an alternate provider snapshot',
      snapshotData: '\x1b[?1049h\x1b[2J\x1b[HStale TUI\r\n',
      snapshotMode: true,
      liveData: '\x1b[?1049lreturned shell\r\n',
      expectedMode: false,
      expectedLine: 'shell history'
    },
    {
      name: 'live entry wins over a primary provider snapshot',
      snapshotData: 'stale shell\r\n',
      snapshotMode: false,
      liveData: '\x1b[?1049h\x1b[2J\x1b[HLive TUI\r\nnew frame\r\n',
      expectedMode: true,
      expectedLine: 'Live TUI'
    }
  ])('$name', async ({ snapshotData, snapshotMode, liveData, expectedMode, expectedLine }) => {
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
    runtime.onPtyData('pty-1', liveData, 101)
    resolveSnapshot({
      data: snapshotData,
      cols: 80,
      rows: 24,
      seq: 900,
      source: 'headless',
      alternateScreen: snapshotMode
    })

    const read = await readPromise
    expect(runtime.isTerminalAlternateScreen('pty-1')).toBe(expectedMode)
    expect(read.tail.join('\n')).toContain(expectedLine)
    expect(read.tail.join('\n')).not.toContain('Stale TUI')
  })
})
