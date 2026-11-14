import { describe, expect, it } from 'vitest'
import './runtime-test-module-registration.spec'
import { HeadlessEmulator } from '../../daemon/emulation/headless-emulator'
import '../../../shared/agent-status/title/osc-title-extraction'
import { OrcaRuntimeService } from '../orca-runtime'
import '../terminal/output/recent-pty-output-buffer'
import '../terminal/output/tail/terminal-tail-buffer'
import '../terminal/output/tail/terminal-tail-state'
import { store, syncSinglePty } from './orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
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
