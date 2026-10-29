// #11315: SSH TUI repaints reach Electron main through onPtyData; tail work must stay linear in bytes.
import { describe, expect, it, vi } from 'vitest'
import * as ansiNormalization from './terminal-ansi-normalization'
import { readPtyTail, runtimeWithLeaf } from './orca-runtime-pty-leaf.test-fixture'

const ESC = '\x1b'
function panelFrames(width: number, frames: number): string {
  const frame = `${ESC}[4A${['title', 'option a', 'option b', 'hint']
    .map((label) => `\r${ESC}[2K${label} ${'─'.repeat(width - label.length - 1)}\n`)
    .join('')}`
  return frame.repeat(frames)
}

describe('onPtyData redraw cost', () => {
  it('replays a full-history TUI redraw without splicing the tail once per line', async () => {
    const ptyId = 'pty-replay'
    const { runtime } = runtimeWithLeaf(ptyId)
    try {
      runtime.onPtyData(ptyId, 'history\n'.repeat(2_000), 0)
      // Park inside the repainted panel so later chunks use the redraw model.
      runtime.onPtyData(ptyId, `${panelFrames(120, 1)}${ESC}[2A`, 1)
      const replay = Array.from({ length: 20_000 }, (_, index) => `line ${index}\r\n`).join('')
      const splice = vi.spyOn(Array.prototype, 'splice')
      let spliceCalls: number
      try {
        runtime.onPtyData(ptyId, `${ESC}[2J${ESC}[H${ESC}[3J${replay}`, 2)
        spliceCalls = splice.mock.calls.length
      } finally {
        splice.mockRestore()
      }
      // Per-row splice made replay O(lines × tail cap) on Electron main.
      expect(spliceCalls).toBeLessThan(100)
      expect(readPtyTail(runtime, ptyId).at(-1)).toBe('line 19999')
    } finally {
      await runtime.onPtyExit(ptyId, 0)
    }
  })

  it('normalizes a chunk once when a diverged leaf carries the same escape prefix', async () => {
    const ptyId = 'pty-diverged'
    const { runtime, leaf } = runtimeWithLeaf(ptyId)
    leaf.tailBuffer = ['leaf-only history']
    leaf.tailLinesTotal = 1
    const normalize = vi.spyOn(ansiNormalization, 'normalizeTerminalChunk')
    try {
      const chunk = panelFrames(80, 3)
      runtime.onPtyData(ptyId, chunk, 1_000)
      expect(normalize.mock.calls.filter(([data]) => data === chunk)).toHaveLength(1)
      expect(leaf.tailBuffer).toContain(`hint ${'─'.repeat(75)}`)
    } finally {
      normalize.mockRestore()
      await runtime.onPtyExit(ptyId, 0)
    }
  })
})
