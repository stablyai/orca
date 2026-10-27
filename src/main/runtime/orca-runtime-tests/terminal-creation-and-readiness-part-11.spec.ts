import { describe, expect, it, vi } from 'vitest'
import {
  HeadlessEmulator,
  MAX_OSC_TITLE_CHARS,
  OrcaRuntimeService,
  RecentPtyOutputBuffer,
  appendNormalizedToTailBuffer,
  buildPreview
} from '../orca-runtime-test-mocks.spec'
import { store, syncSinglePty } from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('trims oversized terminal output bursts without per-line array shifts', async () => {
    const shiftSpy = vi.spyOn(Array.prototype, 'shift')
    const lines = Array.from({ length: 5000 }, (_, index) => `line-${index}`)
    const result = appendNormalizedToTailBuffer([], '', `${lines.join('\n')}\n`)
    const shiftCallCount = shiftSpy.mock.calls.length
    shiftSpy.mockRestore()

    expect(result.truncated).toBe(true)
    expect(result.lines).toHaveLength(2000)
    expect(result.lines.slice(0, 5)).toEqual([
      'line-3000',
      'line-3001',
      'line-3002',
      'line-3003',
      'line-3004'
    ])
    expect(shiftCallCount).toBe(0)
  })

  it('trims terminal tail character budget without per-line array shifts', () => {
    const shiftSpy = vi.spyOn(Array.prototype, 'shift')
    const lines = Array.from({ length: 1000 }, (_, index) => `line-${index}-${'x'.repeat(300)}`)
    const result = appendNormalizedToTailBuffer([], '', `${lines.join('\n')}\n`)
    const shiftCallCount = shiftSpy.mock.calls.length
    shiftSpy.mockRestore()

    let retainedChars = lines.reduce((sum, line) => sum + line.length, 0)
    let expectedStartIndex = 0
    while (expectedStartIndex < lines.length && retainedChars > 256 * 1024) {
      retainedChars -= lines[expectedStartIndex].length
      expectedStartIndex += 1
    }

    expect(result.truncated).toBe(true)
    expect(result.lines).toEqual(lines.slice(expectedStartIndex))
    expect(result.lines.reduce((sum, line) => sum + line.length, 0)).toBeLessThanOrEqual(256 * 1024)
    expect(shiftCallCount).toBe(0)
  })

  it('builds terminal previews without mapping the full retained tail', () => {
    const lines = Array.from({ length: 5000 }, (_, index) =>
      index % 2 === 0 ? `line-${index}` : '   '
    )
    const mapSpy = vi.spyOn(Array.prototype, 'map')

    const preview = buildPreview(lines, 'partial-tail')
    const mapCallCount = mapSpy.mock.calls.length
    mapSpy.mockRestore()

    expect(preview).toBe(
      ['line-4990', 'line-4992', 'line-4994', 'line-4996', 'line-4998', 'partial-tail'].join('\n')
    )
    expect(mapCallCount).toBe(0)
  })

  it('keeps recent PTY replay output capped without needing previous data for large chunks', () => {
    const previous = 'old-output'.repeat(1000)
    const data = 'new-output'.repeat(1000)
    const outputLimit = 64 * 1024

    const smallTail = new RecentPtyOutputBuffer()
    smallTail.append(previous)
    smallTail.append('tail')
    expect(smallTail.read()).toBe(`${previous}tail`.slice(-outputLimit))

    const combined = new RecentPtyOutputBuffer()
    combined.append(previous)
    combined.append(data)
    expect(combined.read()).toBe(`${previous}${data}`.slice(-outputLimit))

    const fresh = new RecentPtyOutputBuffer()
    fresh.append(data)
    expect(fresh.read()).toBe(data.slice(-outputLimit))
  })

  it('applies terminal redraw controls before retaining previews', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', 'Working\rWorking 1s\rWorking 2s', 100)

    const carriageRead = await runtime.readTerminal(terminal.handle)
    expect(carriageRead.tail).toEqual(['Working 2s'])
    expect(carriageRead.latestCursor).toBe('0')

    runtime.onPtyData('pty-1', '\b\b3s', 101)
    const backspaceRead = await runtime.readTerminal(terminal.handle)
    expect(backspaceRead.tail).toEqual(['Working 3s'])
    expect(backspaceRead.latestCursor).toBe('0')

    runtime.onPtyData('pty-1', '\rDone\n', 102)
    const completedRead = await runtime.readTerminal(terminal.handle)
    expect(completedRead.tail).toEqual(['Done'])
    expect(completedRead.latestCursor).toBe('1')
  })

  it('applies ANSI terminal redraw controls before retaining previews', async () => {
    const cursorRedraw = appendNormalizedToTailBuffer([], '', 'Working 10%\x1b[3D25%')
    expect(cursorRedraw.partialLine).toBe('Working 25%')

    const eraseLineKeepsCursor = appendNormalizedToTailBuffer([], '', 'ABC\x1b[2KXY\n')
    expect(eraseLineKeepsCursor.lines).toEqual(['   XY'])

    const eraseWithoutCarriageReturn = appendNormalizedToTailBuffer(
      [],
      'Downloading 10%',
      '\x1b[2K\x1b[1GDownloading 20%'
    )
    expect(eraseWithoutCarriageReturn.partialLine).toBe('Downloading 20%')

    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData(
      'pty-1',
      'Working\r\x1b[2K\x1b[1G\x1b[?25l\x1b[32mDone\x1b[0m\x1b]0;title\u0007\n',
      100
    )

    const read = await runtime.readTerminal(terminal.handle)
    expect(read.tail).toEqual(['Done'])
    expect(read.latestCursor).toBe('1')
  })

  it('retains ANSI-only status redraws instead of appending every frame', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', '• Working', 100)
    const initialPreview = await runtime.readTerminal(terminal.handle)
    expect(initialPreview.tail).toEqual(['• Working'])

    runtime.onPtyData('pty-1', '\x1b[2K\x1b[1G• Working.', 101)
    const redrawPreview = await runtime.readTerminal(terminal.handle)
    expect(redrawPreview.tail).toEqual(['• Working.'])
    expect(redrawPreview.tail.join('\n')).not.toContain('• Working• Working')

    runtime.onPtyData('pty-1', '\x1b[2K\x1b[1G• Working..', 102)
    const latestPreview = await runtime.readTerminal(terminal.handle)
    expect(latestPreview.tail).toEqual(['• Working..'])
    expect(latestPreview.latestCursor).toBe('0')

    const cursorReadBeforeNewline = await runtime.readTerminal(terminal.handle, { cursor: 0 })
    expect(cursorReadBeforeNewline.tail).toEqual([])
    expect(cursorReadBeforeNewline.nextCursor).toBe('0')

    runtime.onPtyData('pty-1', '\n', 103)

    const read = await runtime.readTerminal(terminal.handle)
    expect(read.tail).toEqual(['• Working..'])
    expect(read.latestCursor).toBe('1')
    expect(read.tail.join('\n')).not.toContain('• Working• Working')

    const cursorReadAfterNewline = await runtime.readTerminal(terminal.handle, { cursor: 0 })
    expect(cursorReadAfterNewline.tail).toEqual(['• Working..'])
    expect(cursorReadAfterNewline.nextCursor).toBe('1')
  })

  it('retains multi-line ANSI footer redraws instead of appending old frames', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', '• Working\nTool call\n', 100)
    runtime.onPtyData(
      'pty-1',
      '\x1b[2A\x1b[2K\x1b[1G• Working.\n\x1b[2K\x1b[1GTool call finished\n',
      101
    )

    const read = await runtime.readTerminal(terminal.handle)
    expect(read.tail).toEqual(['• Working.', 'Tool call finished'])
    expect(read.latestCursor).toBe('4')
    expect(read.tail.join('\n')).not.toContain('• Working\nTool call\n• Working.')
    expect(read.tail.join('\n')).not.toContain('2A')
    expect(read.tail.join('\n')).not.toContain('2K')
  })

  it('keeps the cursor column when erasing full lines in multi-line redraws', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', 'ABC\nxyz', 100)
    runtime.onPtyData('pty-1', '\x1b[1A\x1b[2KXY\n', 101)

    const read = await runtime.readTerminal(terminal.handle)
    expect(read.tail).toEqual(['   XY'])
    expect(read.tail.join('\n')).not.toContain('ABCXY')
    expect(read.tail.join('\n')).not.toContain('2K')
  })

  it('retains split multi-line ANSI footer redraw state across chunks', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', '• Working\nTool call\n', 100)
    const beforeRedraw = await runtime.readTerminal(terminal.handle, { cursor: 0 })
    expect(beforeRedraw.tail).toEqual(['• Working', 'Tool call'])
    expect(beforeRedraw.nextCursor).toBe('2')

    runtime.onPtyData('pty-1', '\x1b[2A', 101)
    const betweenChunks = await runtime.readTerminal(terminal.handle)
    expect(betweenChunks.tail).toEqual(['• Working'])
    expect(betweenChunks.latestCursor).toBe('2')

    runtime.onPtyData('pty-1', '\x1b[2K\x1b[1G• Working.\n\x1b[2K\x1b[1GTool call finished\n', 102)

    const read = await runtime.readTerminal(terminal.handle)
    expect(read.tail).toEqual(['• Working.', 'Tool call finished'])
    expect(read.latestCursor).toBe('4')

    const cursorRead = await runtime.readTerminal(terminal.handle, {
      cursor: Number(beforeRedraw.nextCursor)
    })
    expect(cursorRead.tail).toEqual(['• Working.', 'Tool call finished'])
    expect(cursorRead.oldestCursor).toBe('0')
    expect(cursorRead.nextCursor).toBe('4')
  })

  it('does not let stale lower rows hide earlier corrected footer rows from cursor reads', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', 'A\nB\nC\n', 100)
    const beforeRedraw = await runtime.readTerminal(terminal.handle, { cursor: 0 })
    expect(beforeRedraw.tail).toEqual(['A', 'B', 'C'])
    expect(beforeRedraw.nextCursor).toBe('3')

    runtime.onPtyData('pty-1', '\x1b[2A\x1b[2K\x1b[1GB2\n', 101)

    const read = await runtime.readTerminal(terminal.handle)
    expect(read.tail).toEqual(['A', 'B2'])
    expect(read.latestCursor).toBe('4')

    const cursorRead = await runtime.readTerminal(terminal.handle, {
      cursor: Number(beforeRedraw.nextCursor)
    })
    expect(cursorRead.tail).toEqual(['B2'])
    expect(cursorRead.oldestCursor).toBe('0')
    expect(cursorRead.nextCursor).toBe('4')
  })

  it('keeps cursor pagination stable across a CUU redraw of the live screen', async () => {
    const runtime = new OrcaRuntimeService(store)
    const liveScreen = new HeadlessEmulator({ cols: 80, rows: 24 })
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    const initialOutput = 'A\r\nB\r\nC\r\n'
    const redraw = '\x1b[2A\x1b[2K\x1b[1GB2\r\n'
    runtime.onPtyData('pty-1', initialOutput, 100)
    await liveScreen.write(initialOutput)

    const firstPage = await runtime.readTerminal(terminal.handle, { cursor: 0, limit: 2 })
    expect(firstPage).toMatchObject({
      tail: ['A', 'B'],
      truncated: false,
      limited: true,
      oldestCursor: '0',
      nextCursor: '2',
      latestCursor: '3',
      returnedLineCount: 2
    })

    runtime.onPtyData('pty-1', redraw, 101)
    await liveScreen.write(redraw)

    // Mutable-screen cursor movement must not alter completed-line pagination.
    expect(liveScreen.getVisibleLines().filter((line) => line.length > 0)).toEqual(['A', 'B2', 'C'])
    await expect(runtime.readTerminal(terminal.handle, { cursor: 2 })).resolves.toMatchObject({
      tail: ['C', 'B2'],
      truncated: false,
      limited: false,
      oldestCursor: '0',
      nextCursor: '4',
      latestCursor: '4',
      returnedLineCount: 2
    })

    liveScreen.dispose()
  })

  it('records completed transcript lines before later CUU redraws in the same PTY chunk', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', 'A\r\nB\r\nC\r\n\x1b[2A\x1b[2K\x1b[1GB2\r\n', 100)

    await expect(runtime.readTerminal(terminal.handle, { cursor: 0 })).resolves.toMatchObject({
      tail: ['A', 'B', 'C', 'B2'],
      truncated: false,
      oldestCursor: '0',
      nextCursor: '4',
      latestCursor: '4'
    })
  })

  it('bounds completed transcript entries from a single multi-line redraw chunk', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    const lines = Array.from({ length: 2100 }, (_, index) => `redraw-${index}`)
    runtime.onPtyData('pty-1', `\x1b[1A${lines.join('\n')}\n`, 100)

    await expect(
      runtime.readTerminal(terminal.handle, { cursor: 0, limit: 3 })
    ).resolves.toMatchObject({
      tail: ['redraw-100', 'redraw-101', 'redraw-102'],
      truncated: true,
      oldestCursor: '100',
      nextCursor: '103',
      latestCursor: '2100'
    })
  })

  it('retains multi-line ANSI redraws when the last footer row stays partial', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', '• Working\nTool call\n', 100)
    const beforeRedraw = await runtime.readTerminal(terminal.handle, { cursor: 0 })
    expect(beforeRedraw.nextCursor).toBe('2')

    runtime.onPtyData(
      'pty-1',
      '\x1b[2A\x1b[2K\x1b[1G• Working.\n\x1b[2K\x1b[1GTool call still running',
      101
    )

    const read = await runtime.readTerminal(terminal.handle)
    expect(read.tail).toEqual(['• Working.', 'Tool call still running'])
    expect(read.latestCursor).toBe('3')

    const cursorRead = await runtime.readTerminal(terminal.handle, {
      cursor: Number(beforeRedraw.nextCursor)
    })
    expect(cursorRead.tail).toEqual(['• Working.'])
    expect(cursorRead.oldestCursor).toBe('0')
    expect(cursorRead.nextCursor).toBe('3')

    runtime.onPtyData('pty-1', '\n', 102)
    const completedPartialRead = await runtime.readTerminal(terminal.handle, { cursor: 3 })
    expect(completedPartialRead.tail).toEqual(['Tool call still running'])
    expect(completedPartialRead.nextCursor).toBe('4')
  })

  it('does not retain split ANSI controls as visible terminal preview text', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', 'Working\r\x1b[', 100)
    runtime.onPtyData('pty-1', '38;2;190;210;223;49mWo', 101)

    const colorRead = await runtime.readTerminal(terminal.handle)
    const colorRetained = colorRead.tail.join('\n')
    expect(colorRetained).toContain('Wo')
    expect(colorRetained).not.toContain('38;2')
    expect(colorRetained).not.toContain('49m')

    runtime.onPtyData('pty-1', 'rking\x1b[?2026', 102)
    runtime.onPtyData('pty-1', 'l', 103)

    const modeRead = await runtime.readTerminal(terminal.handle)
    const retained = modeRead.tail.join('\n')
    expect(retained).toContain('Working')
    expect(retained).not.toContain('38;2')
    expect(retained).not.toContain('?2026')
    expect(retained).not.toContain('49m')

    runtime.onPtyData('pty-1', ` done\x1b]0;${'x'.repeat(5000)}`, 104)
    runtime.onPtyData('pty-1', '\u0007\n', 105)

    const longRead = await runtime.readTerminal(terminal.handle)
    const longRetained = longRead.tail.join('\n')
    expect(longRetained).toContain('Working done')
    expect(longRetained).not.toContain('x'.repeat(100))
    const pty = (
      runtime as unknown as {
        ptysById: Map<string, { lastOscTitle: string | null }>
      }
    ).ptysById.get('pty-1')
    expect(pty?.lastOscTitle).toBe('x'.repeat(MAX_OSC_TITLE_CHARS))
  })

  it('applies ANSI split redraw controls without leaking raw params', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', 'Frame old', 100)
    runtime.onPtyData('pty-1', '\x1b[', 101)

    const pendingEraseRead = await runtime.readTerminal(terminal.handle)
    expect(pendingEraseRead.tail).toEqual(['Frame old'])
    expect(pendingEraseRead.tail.join('\n')).not.toContain('[')

    runtime.onPtyData('pty-1', '2K\x1b[', 102)
    const pendingColumnRead = await runtime.readTerminal(terminal.handle)
    expect(pendingColumnRead.tail.join('\n')).not.toContain('2K')
    expect(pendingColumnRead.tail.join('\n')).not.toContain('1G')

    runtime.onPtyData('pty-1', '1GFrame new\n', 103)
    const read = await runtime.readTerminal(terminal.handle)
    const retained = read.tail.join('\n')
    expect(read.tail).toEqual(['Frame new'])
    expect(retained).not.toContain('2K')
    expect(retained).not.toContain('1G')
  })

  it('retains same-line redraw cursor position across split full-line erase chunks', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', 'ABC', 100)
    runtime.onPtyData('pty-1', '\x1b[2K', 101)
    const erasedRead = await runtime.readTerminal(terminal.handle)
    expect(erasedRead.tail).toEqual([])

    runtime.onPtyData('pty-1', 'XY\n', 102)

    const read = await runtime.readTerminal(terminal.handle)
    expect(read.tail).toEqual(['   XY'])
    expect(read.tail.join('\n')).not.toContain('ABCXY')
    expect(read.tail.join('\n')).not.toContain('2K')
  })

  it('keeps huge ANSI cursor movement params bounded in retained previews', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    const infinityParam = '9'.repeat(400)
    runtime.onPtyData('pty-1', `A\x1b[1000000000CZ\n`, 100)
    runtime.onPtyData('pty-1', `B\x1b[${infinityParam}GQ\n`, 101)
    for (let index = 0; index < 50; index += 1) {
      runtime.onPtyData('pty-1', `R${index}\x1b[2K\x1b[999999CZ\n`, 102 + index)
    }

    const read = await runtime.readTerminal(terminal.handle, { cursor: 0, limit: 60 })
    expect(read.tail).toHaveLength(52)
    for (const line of read.tail) {
      expect(line.length).toBeLessThan(5000)
      expect(line).not.toContain('1000000000')
      expect(line).not.toContain(infinityParam)
      expect(line).not.toContain('999999')
    }
    expect(read.tail[0]?.startsWith('A')).toBe(true)
    expect(read.tail[0]?.endsWith('Z')).toBe(true)
    expect(read.tail[1]?.startsWith('B')).toBe(true)
    expect(read.tail[1]?.endsWith('Q')).toBe(true)
    expect(read.tail.at(-1)?.endsWith('Z')).toBe(true)
  })
})
