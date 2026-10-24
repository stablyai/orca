import { Script } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { XTERM_ENGINE_JS } from '../terminal-webview-engine.generated'
import { createTerminalDocumentScope } from './document-scope'
import { handleMsg } from './host-message-router'
import { attachTerminalQueryReplyBridge } from './query-reply'
import { stopTerminalInit } from './terminal-init'
import {
  enqueueWrite,
  enqueueWriteBoundary,
  pumpWrites,
  resetWriteQueue,
  TERMINAL_WRITE_SLICE_UNITS
} from './write-queue'

function createParser(scope: ReturnType<typeof createTerminalDocumentScope>) {
  const completions: Array<() => void> = []
  const replies: string[] = []
  const result = {
    maxWrite: 0,
    holdCompletions: false,
    completions,
    replies,
    snapshot: () => '',
    write: (_data: string) => {},
    dispose: () => {}
  }
  const window = {}
  new Script(`${XTERM_ENGINE_JS};
    const terminal = new window.Terminal({ cols: 40, rows: 8, scrollback: 16 });
    const replies = result.replies, titles = [];
    terminal.onData(data => replies.push(data));
    terminal.onTitleChange(title => titles.push(title));
    const write = terminal.write.bind(terminal);
    terminal.write = (data, done) => {
      result.maxWrite = Math.max(result.maxWrite, data.length);
      write(data, () => {
        if (done) {
          if (result.holdCompletions) result.completions.push(done);
          else done();
        }
      });
    };
    result.write = data => terminal.write(data);
    result.dispose = () => terminal.dispose();
    result.snapshot = () => {
      const buffer = terminal.buffer.active;
      const lines = [];
      for (let y = 0; y < buffer.length; y++) {
        const line = buffer.getLine(y), cells = [];
        for (let x = 0; x < terminal.cols; x++) {
          const cell = line.getCell(x);
          cells.push([cell.getChars(), cell.getWidth(), cell.getFgColorMode(), cell.getFgColor(),
            cell.getBgColorMode(), cell.getBgColor(), cell.isBold(), cell.isItalic(), cell.isUnderline()]);
        }
        lines.push([line.isWrapped, cells]);
      }
      return JSON.stringify({ lines, type: buffer.type, cursorX: buffer.cursorX,
        cursorY: buffer.cursorY, baseY: buffer.baseY, modes: terminal.modes, replies, titles });
    };
    scope.term = terminal;
  `).runInNewContext({
    window,
    self: window,
    document: {},
    scope,
    result,
    navigator: { platform: 'Linux', userAgent: 'Chrome/74' },
    structuredClone,
    performance,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    console,
    URL
  })
  scope.ready = true
  return result
}

describe('sliced writes through the shipped xterm parser', () => {
  it.each([
    ['OSC', 3, '\x1b]0;obsolete title\x07'],
    ['DCS', 2, '\x1bP$qm\x1b\\'],
    ['CSI', 3, '\x1b[31mOBSOLETE\x1b[0m'],
    ['ground', 8, 'OBSOLETE'.repeat(3)],
    ['SGR', 20, '\x1b[31mOBSOLETE'.repeat(400)],
    ['surrogate', 1, '\ud83d\ude00OBSOLETE']
  ] as const)(
    'preserves new output when clear cancels a frame inside %s',
    async (_, cut, control) => {
      vi.useFakeTimers()
      const scope = createTerminalDocumentScope({ postToHost: () => {} })
      const baselineScope = createTerminalDocumentScope()
      const parser = createParser(scope)
      const baseline = createParser(baselineScope)
      try {
        enqueueWrite(scope, '\x00'.repeat(TERMINAL_WRITE_SLICE_UNITS - cut) + control)
        const obsoleteBoundary = vi.fn()
        enqueueWriteBoundary(scope, obsoleteBoundary)
        pumpWrites(scope, scope.terminalGeneration)
        handleMsg(scope, { type: 'clear' })
        enqueueWrite(scope, 'CURRENT_GENERATION')
        const currentBoundary = vi.fn()
        enqueueWriteBoundary(scope, currentBoundary)
        pumpWrites(scope, scope.terminalGeneration)
        baseline.write('CURRENT_GENERATION')
        await vi.runAllTimersAsync()
        expect(parser.snapshot()).toBe(baseline.snapshot())
        expect(obsoleteBoundary).not.toHaveBeenCalled()
        expect(currentBoundary).toHaveBeenCalledOnce()
      } finally {
        parser.dispose()
        baseline.dispose()
        vi.useRealTimers()
      }
    }
  )

  const sequences = [
    '\x1b[1;3;4;38;2;12;34;56mCOLOR\x1b[0m',
    '\x1b]0;window title\x07TITLE',
    '\x1b]0;window title\x1b\\TITLE',
    '\x1b]8;;https://example.test/path\x1b\\LINK\x1b]8;;\x1b\\',
    '\x1bP$qm\x1b\\DCS',
    '\x1b[?1004h\x1b[?1004$p\x1b[6n\x1b[5nQUERY',
    '\x1b[?1049hALT\x1b[?1049lNORMAL',
    '\x1b[2J\x1b[3;4HCURSOR\x1b[2D!\x1b[2K',
    '😀e\u0301한글\u{10437}',
    '\x1b]4;1;rgb:00/ff/ff\x07\x1b]4;1;?\x07PALETTE',
    '\x1b[31\x18CANCELLED\x1b[32mGREEN\x1b[0m',
    'one\r\ntwo\r\nthree\r\nfour\r\nfive\r\nsix\r\nseven\r\neight\r\nnine'
  ]

  it.each(sequences)(
    'matches unsliced cells, cursor, modes and replies across every nearby cut: %j',
    async (sequence) => {
      vi.useFakeTimers()
      try {
        for (let offset = 1; offset < sequence.length; offset++) {
          const slicedScope = createTerminalDocumentScope()
          const baselineScope = createTerminalDocumentScope()
          const sliced = createParser(slicedScope)
          const baseline = createParser(baselineScope)
          try {
            const data = '\x00'.repeat(TERMINAL_WRITE_SLICE_UNITS - offset) + sequence + 'END'
            baseline.write(data)
            enqueueWrite(slicedScope, data)
            let replaySnapshot = ''
            enqueueWriteBoundary(slicedScope, () => {
              replaySnapshot = sliced.snapshot()
            })
            enqueueWrite(slicedScope, '\r\nLIVE')
            pumpWrites(slicedScope, slicedScope.terminalGeneration)
            await vi.runAllTimersAsync()
            expect(replaySnapshot, `offset ${offset}`).toBe(baseline.snapshot())
            baseline.write('\r\nLIVE')
            await vi.runAllTimersAsync()
            expect(sliced.snapshot(), `offset ${offset}`).toBe(baseline.snapshot())
            expect(sliced.maxWrite).toBeLessThanOrEqual(TERMINAL_WRITE_SLICE_UNITS)
            expect(slicedScope.writeQueue).toEqual([])
          } finally {
            sliced.dispose()
            baseline.dispose()
          }
        }
      } finally {
        vi.useRealTimers()
      }
    },
    20_000
  )

  it.each([
    ['\x1b]0;', '\x1b\\'],
    ['\x1bP$q', '\x1b\\'],
    ['\x1b[', 'm']
  ])('continues an unfinished control string after many slices: %j', async (start, end) => {
    vi.useFakeTimers()
    const scope = createTerminalDocumentScope()
    const baselineScope = createTerminalDocumentScope()
    const parser = createParser(scope)
    const baseline = createParser(baselineScope)
    try {
      const replay = start + '1;'.repeat(TERMINAL_WRITE_SLICE_UNITS * 4)
      const live = end + 'END'
      baseline.write(replay)
      enqueueWrite(scope, replay)
      let beforeLive = ''
      enqueueWriteBoundary(scope, () => {
        beforeLive = parser.snapshot()
      })
      enqueueWrite(scope, live)
      pumpWrites(scope, scope.terminalGeneration)
      await vi.runAllTimersAsync()
      expect(beforeLive).toBe(baseline.snapshot())
      baseline.write(live)
      await vi.runAllTimersAsync()
      expect(parser.snapshot()).toBe(baseline.snapshot())
      expect(parser.maxWrite).toBeLessThanOrEqual(TERMINAL_WRITE_SLICE_UNITS)
    } finally {
      parser.dispose()
      baseline.dispose()
      vi.useRealTimers()
    }
  })

  it('waits for the clear barrier callback before admitting new output and enabling replies', async () => {
    vi.useFakeTimers()
    const scope = createTerminalDocumentScope({ postToHost: () => {} })
    const baselineScope = createTerminalDocumentScope()
    const parser = createParser(scope)
    const baseline = createParser(baselineScope)
    try {
      parser.holdCompletions = true
      enqueueWrite(scope, '\x00'.repeat(4093) + '\x1b]0;obsolete\x07')
      pumpWrites(scope, scope.terminalGeneration)
      handleMsg(scope, { type: 'clear' })
      enqueueWrite(scope, 'CURRENT')
      const completed = vi.fn()
      enqueueWriteBoundary(scope, completed)
      await vi.runAllTimersAsync()
      expect(parser.completions).toHaveLength(2)
      expect(scope.terminalDataRepliesEnabled).toBe(false)
      expect(completed).not.toHaveBeenCalled()
      parser.completions.shift()!()
      expect(scope.writesDraining).toBe(true)
      expect(completed).not.toHaveBeenCalled()
      parser.holdCompletions = false
      parser.completions.shift()!()
      baseline.write('CURRENT')
      await vi.runAllTimersAsync()
      expect(parser.snapshot()).toBe(baseline.snapshot())
      expect(scope.terminalDataRepliesEnabled).toBe(true)
      expect(completed).toHaveBeenCalledOnce()
    } finally {
      parser.dispose()
      baseline.dispose()
      vi.useRealTimers()
    }
  })

  it('keeps only output following the newest of repeated clear barriers', async () => {
    vi.useFakeTimers()
    const scope = createTerminalDocumentScope({ postToHost: () => {} })
    const baselineScope = createTerminalDocumentScope()
    const parser = createParser(scope)
    const baseline = createParser(baselineScope)
    try {
      enqueueWrite(scope, '\x00'.repeat(4093) + '\x1b]0;obsolete\x07')
      pumpWrites(scope, scope.terminalGeneration)
      const cancelled = vi.fn()
      for (let i = 0; i < 3; i++) {
        handleMsg(scope, { type: 'clear' })
        enqueueWrite(scope, 'CANCELLED_' + i)
        enqueueWriteBoundary(scope, cancelled)
      }
      handleMsg(scope, { type: 'clear' })
      enqueueWrite(scope, 'CURRENT')
      const completed = vi.fn()
      enqueueWriteBoundary(scope, completed)
      baseline.write('CURRENT')
      await vi.runAllTimersAsync()
      expect(parser.snapshot()).toBe(baseline.snapshot())
      expect(cancelled).not.toHaveBeenCalled()
      expect(completed).toHaveBeenCalledOnce()
    } finally {
      parser.dispose()
      baseline.dispose()
      vi.useRealTimers()
    }
  })

  it('abandons a clear barrier when the terminal is replaced before its callback', async () => {
    vi.useFakeTimers()
    const scope = createTerminalDocumentScope({ postToHost: () => {} })
    const baselineScope = createTerminalDocumentScope()
    const obsolete = createParser(scope)
    const baseline = createParser(baselineScope)
    let replacement = obsolete
    try {
      obsolete.holdCompletions = true
      handleMsg(scope, { type: 'clear' })
      await vi.runAllTimersAsync()
      expect(obsolete.completions).toHaveLength(1)
      scope.terminalGeneration++
      resetWriteQueue(scope)
      scope.writesDraining = false
      scope.afterDrainCallbacks = []
      obsolete.dispose()
      replacement = createParser(scope)
      replacement.holdCompletions = true
      enqueueWrite(scope, 'CURRENT')
      pumpWrites(scope, scope.terminalGeneration)
      await vi.runAllTimersAsync()
      obsolete.completions.shift()!()
      expect(scope.writesDraining).toBe(true)
      expect(replacement.completions).toHaveLength(1)
      replacement.completions.shift()!()
      baseline.write('CURRENT')
      await vi.runAllTimersAsync()
      expect(replacement.snapshot()).toBe(baseline.snapshot())
      expect(scope.writesDraining).toBe(false)
    } finally {
      replacement.dispose()
      obsolete.dispose()
      baseline.dispose()
      vi.useRealTimers()
    }
  })

  it('keeps a clear barrier ahead of output queued before ready', async () => {
    vi.useFakeTimers()
    const scope = createTerminalDocumentScope({ postToHost: () => {} })
    const baselineScope = createTerminalDocumentScope()
    const parser = createParser(scope)
    const baseline = createParser(baselineScope)
    try {
      scope.ready = false
      enqueueWrite(scope, 'OBSOLETE')
      handleMsg(scope, { type: 'clear' })
      enqueueWrite(scope, 'CURRENT')
      pumpWrites(scope, scope.terminalGeneration)
      await vi.runAllTimersAsync()
      expect(scope.terminalDataRepliesEnabled).toBe(false)
      expect(parser.maxWrite).toBe(0)
      scope.ready = true
      pumpWrites(scope, scope.terminalGeneration)
      baseline.write('CURRENT')
      await vi.runAllTimersAsync()
      expect(parser.snapshot()).toBe(baseline.snapshot())
      expect(scope.terminalDataRepliesEnabled).toBe(true)
    } finally {
      parser.dispose()
      baseline.dispose()
      vi.useRealTimers()
    }
  })

  it('does not reset surfaces, resume replies or emit metadata after stop cancels the clear', async () => {
    vi.useFakeTimers()
    const postToHost = vi.fn()
    const scope = createTerminalDocumentScope({ postToHost })
    const parser = createParser(scope)
    try {
      parser.holdCompletions = true
      handleMsg(scope, { type: 'clear' })
      await vi.runAllTimersAsync()
      expect(parser.completions).toHaveLength(1)
      stopTerminalInit(scope)
      postToHost.mockClear()
      parser.completions.shift()!()
      expect(scope.term).toBeNull()
      expect(scope.terminalDataRepliesEnabled).toBe(false)
      expect(postToHost).not.toHaveBeenCalled()
    } finally {
      parser.dispose()
      vi.useRealTimers()
    }
  })

  it('forwards only new-generation query replies after the cancellation boundary', async () => {
    vi.useFakeTimers()
    const postToHost = vi.fn()
    const scope = createTerminalDocumentScope({ postToHost })
    const parser = createParser(scope)
    try {
      attachTerminalQueryReplyBridge(scope, scope.term!, scope.terminalGeneration)
      pumpWrites(scope, scope.terminalGeneration)
      enqueueWrite(scope, '\x1b[6n' + '\x00'.repeat(4089) + '\x1b]0;obsolete\x07')
      pumpWrites(scope, scope.terminalGeneration)
      handleMsg(scope, { type: 'clear' })
      enqueueWrite(scope, '\x1b[6nCURRENT')
      pumpWrites(scope, scope.terminalGeneration)
      await vi.runAllTimersAsync()
      expect(parser.replies).toEqual(['\x1b[1;1R', '\x1b[1;1R'])
      const forwarded = postToHost.mock.calls
        .map(([message]) => message)
        .filter((message) => message.type === 'terminal-data')
      expect(forwarded).toEqual([{ type: 'terminal-data', bytes: '\x1b[1;1R' }])
      expect(scope.term!.buffer.active.getLine(0)!.translateToString(true)).toBe('CURRENT')
    } finally {
      parser.dispose()
      vi.useRealTimers()
    }
  })

  it('keeps the UTF-16 decoder and status-dot carry across incoming host chunks', async () => {
    vi.useFakeTimers()
    const scope = createTerminalDocumentScope()
    const baselineScope = createTerminalDocumentScope()
    const parser = createParser(scope)
    const baseline = createParser(baselineScope)
    try {
      const prefix = '\x00'.repeat(TERMINAL_WRITE_SLICE_UNITS * 2 - 1)
      for (const chunk of [prefix + '\ud83d', '\ude00\u23fa', '\ufe0f', '\ufe0eTEXT']) {
        enqueueWrite(scope, chunk)
      }
      pumpWrites(scope, scope.terminalGeneration)
      baseline.write(prefix + '😀\u23fa\ufe0eTEXT')
      await vi.runAllTimersAsync()
      expect(parser.snapshot()).toBe(baseline.snapshot())
    } finally {
      parser.dispose()
      baseline.dispose()
      vi.useRealTimers()
    }
  })
})
