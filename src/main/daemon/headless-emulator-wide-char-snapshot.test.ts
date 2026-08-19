/**
 * #15192 coverage gap: the model-snapshot fuzzers exercise wide text only through
 * a single `你好世界` word, so a leading/trailing-cell fault in the main-side
 * snapshot path could survive them. This sweeps Hangul across every width where
 * a syllable can straddle the wrap boundary and pins that the restore the
 * renderer replays holds the same text the model does.
 */
import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { HeadlessEmulator } from './headless-emulator'
import { activateOrcaTerminalUnicodeProvider } from '../../shared/terminal-unicode-provider'

const KO =
  '안녕하세요 오르카 테스트입니다. 결론부터 말씀드리면 시각적 피로도 절제된 럭셔리 다크 테마 가독성 행간(1.75) 적용 roadmap/complete-overhaul-backlog-history.md'

function textOf(t: Terminal): string {
  const b = t.buffer.active
  const out: string[] = []
  for (let y = 0; y < b.length; y++) {
    out.push(b.getLine(y)?.translateToString(true) ?? '')
  }
  return out.join('').replace(/\s+/g, '')
}

function replay(
  snapshot: { scrollbackAnsi?: string; snapshotAnsi: string },
  cols: number,
  rows: number
): string {
  const t = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true })
  t.loadAddon(new Unicode11Addon())
  activateOrcaTerminalUnicodeProvider(t as never)
  const core = (t as unknown as { _core: { writeSync(d: string): void } })._core
  core.writeSync(`${snapshot.scrollbackAnsi ?? ''}${snapshot.snapshotAnsi}`)
  return textOf(t)
}

describe('headless emulator wide-character snapshot fidelity', () => {
  it('does not duplicate Hangul across widths', () => {
    const bad: string[] = []
    for (let cols = 12; cols <= 80; cols++) {
      const emu = new HeadlessEmulator({ cols, rows: 14 })
      emu.write(`${KO}\r\n${KO}\r\n`)
      const snap = emu.getSnapshot({ scrollbackRows: 200 })
      const src = textOf((emu as unknown as { terminal: Terminal }).terminal)
      const rt = replay(snap, cols, 14)
      // Why: an empty read would satisfy src === rt and assert nothing.
      expect(src.length).toBeGreaterThan(0)
      if (src !== rt) {
        bad.push(`cols=${cols}\n  src: ${src}\n  rt : ${rt}`)
      }
      emu.dispose()
    }
    expect(bad).toEqual([])
  })
})
