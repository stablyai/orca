import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  store,
  syncSinglePty
} from '../orca-runtime-test-fixtures.spec'

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

  it('reports an in-flight PTY focus as not navigated when its notifier disappears', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.registerPty('pty-a', TEST_WORKTREE_ID)
    const terminal = (await runtime.listTerminals()).terminals.find(
      (candidate) => candidate.ptyId === 'pty-a'
    )
    expect(terminal).toBeDefined()

    let releaseReveal!: (value: { tabId: string }) => void
    const revealTerminalSession = vi.fn(
      () =>
        new Promise<{ tabId: string }>((resolve) => {
          releaseReveal = resolve
        })
    )
    runtime.setNotifier({ revealTerminalSession } as never)

    const focus = runtime.focusTerminal(terminal!.handle)
    await vi.waitFor(() => expect(revealTerminalSession).toHaveBeenCalledOnce())
    runtime.setNotifier(null)
    releaseReveal({ tabId: 'tab-a' })

    await expect(focus).resolves.toMatchObject({
      handle: terminal!.handle,
      tabId: 'tab-a',
      navigated: false
    })
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

  it('reports graph-leaf focus as not navigated without a host notifier', async () => {
    const runtime = new OrcaRuntimeService(store)
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
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.focusTerminal(terminal.handle)).resolves.toEqual({
      handle: terminal.handle,
      tabId: 'tab-leaf',
      worktreeId: TEST_WORKTREE_ID,
      navigated: false
    })
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

    await expect(runtime.clearTerminalBuffer(terminal.handle)).resolves.toEqual({
      handle: terminal.handle,
      cleared: true
    })

    expect(clearBuffer).toHaveBeenCalledWith('pty-1')
    const snapshot = await runtime.serializeTerminalBuffer('pty-1', { scrollbackRows: 1000 })
    expect(snapshot?.data).not.toContain('line-0')
  })

  it('waits for terminal exit and resolves with the exit status', async () => {
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
    const waitPromise = runtime.waitForTerminal(terminal.handle, { timeoutMs: 1000 })
    runtime.onPtyExit('pty-1', 7)

    await expect(waitPromise).resolves.toMatchObject({
      handle: terminal.handle,
      condition: 'exit',
      satisfied: true,
      status: 'exited',
      exitCode: 7
    })
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

    // Non-cursor reads include the partial line for UI display
    const firstRead = await runtime.readTerminal(terminal.handle)
    expect(firstRead.tail).toEqual(['hel'])
    expect(firstRead.nextCursor).toBe('0')

    runtime.onPtyData('pty-1', 'lo', 101)

    // Cursor reads exclude partial lines to prevent duplication (partial now, then completed line next read).
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

  // Why: PR #2553 keeps retained output cursor-reachable while previews stay bounded (not full-transcript payloads).
  it('keeps terminal read payloads bounded while retained output remains pageable', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    const linePayload = 'x'.repeat(24)
    const lines = Array.from(
      { length: 2000 },
      (_, index) => `line-${index.toString().padStart(4, '0')}-${linePayload}`
    )
    runtime.onPtyData('pty-1', `${lines.join('\n')}\n`, 100)

    const preview = await runtime.readTerminal(terminal.handle)
    expect(Buffer.byteLength(JSON.stringify(preview), 'utf8')).toBeLessThan(10_000)
    expect(preview.tail).toHaveLength(120)
    expect(preview.tail[0]).toBe(lines.at(-120))
    expect(preview.limited).toBe(true)
    expect(preview.oldestCursor).toBe('0')
    expect(preview.nextCursor).toBe('2000')
    expect(preview.latestCursor).toBe('2000')

    const collected: string[] = []
    let cursor = Number(preview.oldestCursor)
    const latestCursor = Number(preview.latestCursor)
    for (let pageIndex = 0; cursor < latestCursor; pageIndex += 1) {
      expect(pageIndex).toBeLessThan(10)
      const page = await runtime.readTerminal(terminal.handle, { cursor, limit: 333 })
      expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThan(16_000)
      expect(page.tail.length).toBeGreaterThan(0)
      expect(page.tail.length).toBeLessThanOrEqual(333)
      expect(page.returnedLineCount).toBe(page.tail.length)

      collected.push(...page.tail)
      const nextCursor = Number(page.nextCursor)
      expect(nextCursor).toBeGreaterThan(cursor)
      cursor = nextCursor
    }

    expect(collected).toHaveLength(lines.length)
    expect(collected.findIndex((line, index) => line !== lines[index])).toBe(-1)
  })

  it('trims terminal read preview character budget without per-line array shifts', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    const lines = Array.from({ length: 120 }, (_, index) => `line-${index}-${'x'.repeat(400)}`)
    runtime.onPtyData('pty-1', `${lines.join('\n')}\n`, 100)
    // Why: xterm-headless uses Array.shift while draining writes; this test guards read-preview trimming, not emulator parsing.
    await runtime.serializeMainTerminalBuffer('pty-1')

    const originalShift = Array.prototype.shift
    let shiftCallCount = 0
    Array.prototype.shift = function (...args) {
      shiftCallCount += 1
      return originalShift.apply(this, args)
    }
    let preview: Awaited<ReturnType<typeof runtime.readTerminal>>
    try {
      preview = await runtime.readTerminal(terminal.handle)
    } finally {
      Array.prototype.shift = originalShift
    }

    expect(preview.limited).toBe(true)
    expect(preview.tail.at(-1)).toBe(lines.at(-1))
    expect(preview.tail.reduce((sum, line) => sum + line.length, 0)).toBeLessThanOrEqual(32 * 1024)
    expect(shiftCallCount).toBe(0)
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
