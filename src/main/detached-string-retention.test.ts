import { describe, expect, it } from 'vitest'
import {
  measureRetention,
  retentionCase,
  type RetentionCase
} from '../shared/string-retention-measurement'
import { extractOscScanTail } from './daemon/osc7-uri-extraction'
import { TerminalMouseModeMirror } from './daemon/terminal-mouse-mode-mirror'
import { createSetupCompletionScanner } from './runtime/orchestration/setup-completion-signal'
import { retainTerminalPendingAnsi } from './runtime/terminal-pending-ansi'
import { AgentDetector } from './stats/agent-detector'

const PTY_CHUNK_CHARS = 16 * 1024
const PTYS = 512

// Production keys one tail per PTY off a single detector, so share it across samples.
const meaningfulContentDetector = new AgentDetector({
  onAgentStart: () => undefined,
  onAgentStop: () => undefined
} as never)

const RETENTION_CASES: RetentionCase[] = [
  retentionCase({
    name: 'terminal pending ansi tail',
    sourceChars: PTY_CHUNK_CHARS,
    samples: PTYS,
    source: (index) => `${'x'.repeat(PTY_CHUNK_CHARS)}\x1b]0;partial-${index}`,
    retain: (source) => retainTerminalPendingAnsi(source.slice(source.lastIndexOf('\x1b'))),
    verify: (first) => {
      expect(first).toBe('\x1b]0;partial-0')
    }
  }),

  // Production persists one scan tail per daemon session.
  retentionCase({
    name: 'mouse mode private-mode tail',
    sourceChars: PTY_CHUNK_CHARS,
    samples: PTYS,
    source: (index) => `${'x'.repeat(PTY_CHUNK_CHARS)}session-${index}\x1b[?1002;1006;100`,
    retain: (source) => {
      const mirror = new TerminalMouseModeMirror()
      mirror.scan(source)
      return mirror
    },
    verify: (first) => {
      first.scan('3h')
      expect(first.mouseTrackingMode).toBe('any')
      expect(first.sgrMouseMode).toBe(true)
    }
  }),

  // Production persists one scan tail per PTY and daemon scanner.
  retentionCase({
    name: 'osc7 scan tail',
    sourceChars: PTY_CHUNK_CHARS,
    samples: PTYS,
    source: (index) =>
      `${'x'.repeat(PTY_CHUNK_CHARS)}\x1b]7;file://host/Users/dev/orca/wt-${index}`,
    retain: (source) => extractOscScanTail(source, 4096),
    verify: (first) => {
      expect(first).toBe('\x1b]7;file://host/Users/dev/orca/wt-0')
    }
  }),

  // Production persists one meaningful-content tail per PTY.
  retentionCase({
    name: 'agent detector meaningful-content tail',
    sourceChars: PTY_CHUNK_CHARS,
    samples: PTYS,
    source: (index) => `${'y'.repeat(PTY_CHUNK_CHARS)}pty-${index}\x1b[38;2;12;34;5`,
    retain: (source, index) => {
      meaningfulContentDetector.onData(`pty-${index}`, '\x1b]0;⠂ Writing patch\x07', 100)
      meaningfulContentDetector.onData(`pty-${index}`, source, 200)
      return meaningfulContentDetector
    },
    verify: (first) => {
      expect(first.trackedPtyCount).toBe(PTYS)
    }
  }),

  // Production persists one carry per running setup.
  retentionCase({
    name: 'setup completion scanner carry',
    sourceChars: PTY_CHUNK_CHARS,
    samples: PTYS,
    source: (index) => `${'x'.repeat(PTY_CHUNK_CHARS)}setup-${index}`,
    retain: (source, index) => {
      const exitCodes: number[] = []
      const scanner = createSetupCompletionScanner(`token-${index}`, (code) => exitCodes.push(code))
      scanner.scan(source)
      return { scanner, exitCodes }
    },
    verify: (first) => {
      first.scanner.scan('__ORCA_SETUP_COMPLETE__:token-0')
      first.scanner.scan(':7\n')
      expect(first.exitCodes).toEqual([7])
    }
  })
]

describe('detached string retention (main)', () => {
  it.each(RETENTION_CASES)('$name does not pin its source', (entry) => {
    const measured = measureRetention(entry)
    expect(measured.samples).toBe(entry.samples)
    entry.verify(measured.first as never)
    expect(
      measured.retainedMiB,
      `${entry.name}: retained ${measured.retainedMiB.toFixed(2)} MiB of a possible ${measured.pinnedMiB} MiB`
    ).toBeLessThan(measured.budgetMiB)
  })
})
