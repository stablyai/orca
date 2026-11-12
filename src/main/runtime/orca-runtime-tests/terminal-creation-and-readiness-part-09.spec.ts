import { describe, expect, it, vi } from 'vitest'
import './runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'

import '../../../shared/terminal/protocol/input-modes/terminal-kitty-keyboard-mode-tracker'
import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  store,
  syncSinglePty
} from './orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('reports a queued PTY focus as not navigated when its notifier disappears', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.registerPty('pty-a', TEST_WORKTREE_ID)
    runtime.registerPty('pty-b', TEST_WORKTREE_ID)
    const terminals = (await runtime.listTerminals()).terminals
    const terminalA = terminals.find((terminal) => terminal.ptyId === 'pty-a')
    const terminalB = terminals.find((terminal) => terminal.ptyId === 'pty-b')
    expect(terminalA).toBeDefined()
    expect(terminalB).toBeDefined()

    let releaseReveal!: (value: { tabId: string }) => void
    const revealGate = new Promise<{ tabId: string }>((resolve) => {
      releaseReveal = resolve
    })
    const revealTerminalSession = vi
      .fn()
      .mockImplementationOnce(() => revealGate)
      .mockResolvedValue({ tabId: 'tab-b' })
    runtime.setNotifier({ revealTerminalSession } as never)

    const first = runtime.focusTerminal(terminalA!.handle)
    await vi.waitFor(() => expect(revealTerminalSession).toHaveBeenCalledOnce())
    const queued = runtime.focusTerminal(terminalB!.handle)
    runtime.setNotifier(null)
    releaseReveal({ tabId: 'tab-a' })

    await expect(first).resolves.toMatchObject({ handle: terminalA!.handle, navigated: false })
    await expect(queued).resolves.toMatchObject({ handle: terminalB!.handle, navigated: false })
    expect(revealTerminalSession).toHaveBeenCalledOnce()
  })

  it('does not invoke a stale graph-leaf focus notifier after queued PTY work', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-leaf',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Starting terminal',
          activeLeafId: HEADLESS_LEAF_ID,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-leaf',
          worktreeId: TEST_WORKTREE_ID,
          leafId: HEADLESS_LEAF_ID,
          paneRuntimeId: 1,
          ptyId: null
        }
      ]
    })
    const leafTerminal = (await runtime.listTerminals()).terminals.find(
      (terminal) => terminal.tabId === 'tab-leaf'
    )
    runtime.registerPty('pty-a', TEST_WORKTREE_ID)
    const ptyTerminal = (await runtime.listTerminals()).terminals.find(
      (terminal) => terminal.ptyId === 'pty-a'
    )
    expect(ptyTerminal).toBeDefined()
    expect(leafTerminal).toBeDefined()

    let releaseReveal!: (value: { tabId: string }) => void
    const revealGate = new Promise<{ tabId: string }>((resolve) => {
      releaseReveal = resolve
    })
    const focusTerminal = vi.fn()
    const revealTerminalSession = vi.fn(() => revealGate)
    runtime.setNotifier({
      revealTerminalSession,
      focusTerminal
    } as never)

    const first = runtime.focusTerminal(ptyTerminal!.handle)
    await vi.waitFor(() => expect(revealTerminalSession).toHaveBeenCalledOnce())
    const queued = runtime.focusTerminal(leafTerminal!.handle)
    runtime.setNotifier(null)
    releaseReveal({ tabId: 'tab-a' })

    await expect(first).resolves.toMatchObject({ handle: ptyTerminal!.handle, navigated: false })
    await expect(queued).resolves.toMatchObject({ handle: leafTerminal!.handle, navigated: false })
    expect(focusTerminal).not.toHaveBeenCalled()
  })

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

  it('paginates retained terminal output with explicit limits and truncation metadata', async () => {
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
    runtime.onPtyData(
      'pty-1',
      `${Array.from({ length: 150 }, (_, index) => `line-${index}`).join('\n')}\n`,
      100
    )

    const preview = await runtime.readTerminal(terminal.handle)
    expect(preview.tail).toHaveLength(120)
    expect(preview.tail[0]).toBe('line-30')
    expect(preview.limited).toBe(true)
    expect(preview.oldestCursor).toBe('0')
    expect(preview.latestCursor).toBe('150')

    const defaultCursorRead = await runtime.readTerminal(terminal.handle, { cursor: 0 })
    expect(defaultCursorRead.tail).toHaveLength(150)
    expect(defaultCursorRead.nextCursor).toBe('150')
    expect(defaultCursorRead.limited).toBe(false)

    const firstPage = await runtime.readTerminal(terminal.handle, { cursor: 0, limit: 50 })
    expect(firstPage.tail).toHaveLength(50)
    expect(firstPage.tail[0]).toBe('line-0')
    expect(firstPage.nextCursor).toBe('50')
    expect(firstPage.limited).toBe(true)
    expect(firstPage.truncated).toBe(false)

    const fractionalPage = await runtime.readTerminal(terminal.handle, { cursor: 0, limit: 0.5 })
    expect(fractionalPage.tail).toEqual(['line-0'])
    expect(fractionalPage.nextCursor).toBe('1')
    expect(fractionalPage.limited).toBe(true)

    const secondPage = await runtime.readTerminal(terminal.handle, {
      cursor: Number(firstPage.nextCursor),
      limit: 200
    })
    expect(secondPage.tail).toHaveLength(100)
    expect(secondPage.tail[0]).toBe('line-50')
    expect(secondPage.nextCursor).toBe('150')
    expect(secondPage.limited).toBe(false)

    runtime.onPtyData(
      'pty-1',
      `${Array.from({ length: 2100 }, (_, index) => `later-${index}`).join('\n')}\n`,
      101
    )

    const staleCursorRead = await runtime.readTerminal(terminal.handle, { cursor: 0, limit: 5 })
    expect(staleCursorRead.truncated).toBe(true)
    expect(staleCursorRead.oldestCursor).toBe('250')
    expect(staleCursorRead.tail).toEqual([
      'later-100',
      'later-101',
      'later-102',
      'later-103',
      'later-104'
    ])
    expect(staleCursorRead.nextCursor).toBe('255')

    const futureCursorRead = await runtime.readTerminal(terminal.handle, { cursor: 9999 })
    expect(futureCursorRead.tail).toEqual([])
    expect(futureCursorRead.nextCursor).toBe('2250')
    expect(futureCursorRead.limited).toBe(false)
  })

  it('falls back to renderer visible screen when uncursored TUI tail is blank', async () => {
    const serializeBuffer = vi.fn().mockResolvedValue({
      data: '\x1b[?1049hClaude Code\r\nWorking on fix\r\nTool: Read\r\n',
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
    runtime.onPtyData('pty-1', `${Array.from({ length: 3000 }, () => '   ').join('\n')}\n`, 100)

    const read = await runtime.readTerminal(terminal.handle)

    expect(read.tail).toEqual(['Claude Code', 'Working on fix', 'Tool: Read'])
    expect(serializeBuffer).toHaveBeenCalledWith('pty-1', {
      scrollbackRows: 0
    })
  })

  it('reads and shows the runtime-owned alternate-screen grid without serialization', async () => {
    const serializeBuffer = vi.fn()
    const serializeProviderBuffer = vi.fn()
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      serializeBuffer,
      serializeProviderBuffer
    })
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData(
      'pty-1',
      'shell history\r\n\x1b[?1049h\x1b[2J\x1b[HClaude Code\r\nWorking on fix\r\nTool: Read\r\n',
      100
    )

    const read = await runtime.readTerminal(terminal.handle)
    const shown = await runtime.showTerminal(terminal.handle)

    expect(read.tail).toEqual(['Claude Code', 'Working on fix', 'Tool: Read'])
    expect(shown.preview).toBe('Claude Code\nWorking on fix\nTool: Read')
    expect(serializeBuffer).not.toHaveBeenCalled()
    expect(serializeProviderBuffer).not.toHaveBeenCalled()
  })

  it('classifies older provider alternate-screen snapshots from ANSI', async () => {
    const serializeProviderBuffer = vi.fn().mockResolvedValue({
      data: '\x1b[?1049h\x1b[2J\x1b[HRemote Vim\r\nediting README.md\r\n',
      cols: 80,
      rows: 24,
      seq: 900,
      source: 'headless'
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

    expect(read.tail).toEqual(['Remote Vim', 'editing README.md'])
    expect(runtime.isTerminalAlternateScreen('pty-1')).toBe(true)
    expect(serializeProviderBuffer).toHaveBeenCalledOnce()
  })

  it('honors the last ANSI screen transition when older provider metadata is absent', async () => {
    const serializeProviderBuffer = vi.fn().mockResolvedValue({
      data: '\x1b[?1049hOld TUI\r\n\x1b[?1049l',
      cols: 80,
      rows: 24,
      seq: 900,
      source: 'headless'
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
    runtime.onPtyData('pty-1', 'shell history\r\n', 100)
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-1',
      { value: 900, generation: 'continued' },
      0
    )

    const [terminal] = (await runtime.listTerminals()).terminals
    const read = await runtime.readTerminal(terminal.handle)

    expect(read.tail).toEqual(['shell history'])
    expect(runtime.isTerminalAlternateScreen('pty-1')).toBe(false)
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
