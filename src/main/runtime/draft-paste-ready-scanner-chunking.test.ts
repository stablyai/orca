/**
 * The draft-paste scanner must answer the same way however the PTY splits a stream into reads.
 * Every committed capture whose signal revokes its anchor is replayed whole, one char at a time,
 * in its recorded reads (where timed) and in seeded random chunkings, and each must turn ready on
 * the read holding the offset a plain string walk finds. A regression guard for grok, DSH and
 * ZCode (their markers are one char, so the seam fix cannot move them), and the proof for OpenCode.
 * OpenCode's agent-row signal reads screen structure no string walk expresses, so its reference is
 * the scanner fed one char at a time; the transcript suites prove where that lands.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDraftPasteReadyScanner } from '../../shared/draft-paste-ready-scanner'
import type { DraftPasteReadySignal } from '../../shared/tui-agent-config'
import { GROK_STARTUP_PTY_TRACE } from '../../shared/__fixtures__/grok-startup-pty-trace'
import { GROK_INLINE_STARTUP_PTY_TRACE } from '../../shared/__fixtures__/grok-inline-startup-pty-trace'
import type { GrokStartupTraceChunk } from '../../shared/__fixtures__/grok-startup-pty-trace'
import { readRuntimeFixture, readTimedRuntimeFixture } from './agent-transcript-replay-test-harness'

type Walk = { anchor: string; end: string; marker: string }

const ALT_SCREEN: Walk = { anchor: '\x1b[?1049h', end: '\x1b[?1049l', marker: '' }
const WALKS: Partial<Record<DraftPasteReadySignal, Walk>> = {
  'render-cursor-after-bracketed-paste': {
    anchor: '\x1b[?2004h',
    end: '\x1b[?2004l',
    marker: '\x1b[?25h'
  },
  'grok-composer-prompt': { ...ALT_SCREEN, marker: '❯' },
  'dsh-composer-prompt': { ...ALT_SCREEN, marker: '❯' },
  'zcode-composer-prompt': { ...ALT_SCREEN, marker: '╭' }
}

// Recorded zsh shape: the prompt enables bracketed paste and accept-line disables it before exec.
// The launcher's cursor toggle after that is synthetic, standing in for any spinner, and so is the
// `·` in the prompt, standing in for a theme that draws OpenCode's agent-row separator.
const ZSH_LAUNCH_PROLOGUE =
  '\x1b[?2004h~ \u00b7 main % opencode\x1b[?2004l\r\n\x1b]2;opencode\x07\x1b[?25lresolving\x1b[?25h\r\n'

const OPENCODE_TIMED = [
  'opencode-1-18-32-timed-boot-slow',
  'opencode-1-18-32-timed-boot-hidden-pane',
  'opencode-1-18-32-timed-first-launch',
  'opencode-2-0-18-timed-boot-hidden-pane',
  'opencode-2-0-21-timed-cold-standalone',
  'opencode-2-0-21-timed-cold-standalone-hidden-pane',
  'opencode-2-0-21-timed-natural-load-enter-dropped',
  'opencode-2-0-21-timed-enter-after-agent-row',
  'opencode-2-0-14-timed-cold-standalone',
  'opencode-cmd-2-0-21-timed-warm-server'
]

type Case = { name: string; signal: DraftPasteReadySignal; data: string; reads?: string[] }

function readPtyTranscript(name: string): string {
  return readFileSync(
    join(__dirname, '..', 'daemon', '__fixtures__', 'pty-transcripts', name),
    'utf8'
  )
}

function grokCase(name: string, trace: GrokStartupTraceChunk[]): Case {
  const reads = trace.map((chunk) => chunk.data ?? 'x'.repeat(chunk.bytes ?? 0))
  return { name, signal: 'grok-composer-prompt', data: reads.join(''), reads }
}

const CASES: Case[] = [
  grokCase('grok 1.0.0 alt screen', GROK_STARTUP_PTY_TRACE),
  grokCase('grok 1.0.0 inline', GROK_INLINE_STARTUP_PTY_TRACE),
  {
    name: 'dsh-tui-ready-no-key',
    signal: 'dsh-composer-prompt',
    data: readRuntimeFixture('dsh-tui-ready-no-key')
  },
  {
    name: 'zcode-composer-ready',
    signal: 'zcode-composer-prompt',
    data: readRuntimeFixture('zcode-composer-ready')
  },
  {
    name: 'opencode (untimed pty transcript)',
    signal: 'render-cursor-after-bracketed-paste',
    data: readPtyTranscript('opencode.txt')
  },
  ...(['render-cursor-after-bracketed-paste', 'opencode-agent-row'] as const).flatMap((signal) =>
    OPENCODE_TIMED.flatMap((name): Case[] => {
      const { chunks } = readTimedRuntimeFixture(name)
      return [
        { name: `${name} (${signal})`, signal, data: chunks.join(''), reads: chunks },
        {
          name: `${name} behind a zsh launch (${signal})`,
          signal,
          data: ZSH_LAUNCH_PROLOGUE + chunks.join(''),
          reads: [ZSH_LAUNCH_PROLOGUE, ...chunks]
        }
      ]
    })
  )
]

/** End offset of the first marker seen while the anchor is held, walking the whole string. */
function walkReadyEnd(data: string, { anchor, end, marker }: Walk): number | null {
  let cursor = 0
  for (;;) {
    const enter = data.indexOf(anchor, cursor)
    if (enter === -1) {
      return null
    }
    cursor = enter + anchor.length
    const leave = data.indexOf(end, cursor)
    const found = data.indexOf(marker, cursor)
    if (found !== -1 && (leave === -1 || found + marker.length <= leave)) {
      return found + marker.length
    }
    if (leave === -1) {
      return null
    }
    cursor = leave + end.length
  }
}

/** [start, end) of the first read the scanner reports ready on, or null. */
function scanReadyRead(signal: DraftPasteReadySignal, reads: string[]): [number, number] | null {
  const scanner = createDraftPasteReadyScanner(signal)
  let offset = 0
  for (const read of reads) {
    if (scanner.observe(read).ready) {
      return [offset, offset + read.length]
    }
    offset += read.length
  }
  return null
}

function splitAt(data: string, sizes: () => number): string[] {
  const reads: string[] = []
  for (let offset = 0; offset < data.length;) {
    const size = sizes()
    reads.push(data.slice(offset, offset + size))
    offset += size
  }
  return reads
}

// mulberry32: a fixed seed keeps every chunking reproducible.
function seededSizes(seed: number, max: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return 1 + Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * max)
  }
}

function chunkings(testCase: Case): Map<string, string[]> {
  const { data } = testCase
  const result = new Map<string, string[]>([
    ['whole', [data]],
    ['one char per read', splitAt(data, () => 1)]
  ])
  if (testCase.reads) {
    result.set('recorded reads', testCase.reads)
  }
  for (let seed = 0; seed < 12; seed += 1) {
    const max = seed % 2 === 0 ? 16 : 2048
    result.set(`random chunking ${seed}`, splitAt(data, seededSizes(seed + 1, max)))
  }
  return result
}

describe('draft-paste readiness does not depend on how the stream is chunked', () => {
  it.each(CASES.map((testCase) => [testCase.name, testCase] as const))('%s', (_, testCase) => {
    const walk = WALKS[testCase.signal]
    const expected = walk
      ? walkReadyEnd(testCase.data, walk)
      : (scanReadyRead(
          testCase.signal,
          splitAt(testCase.data, () => 1)
        )?.[1] ?? null)
    if (!walk) {
      expect(testCase.signal).toBe('opencode-agent-row')
      expect(expected, 'every OpenCode capture paints its agent row').not.toBeNull()
    }
    for (const [label, reads] of chunkings(testCase)) {
      const readyRead = scanReadyRead(testCase.signal, reads)
      if (expected === null) {
        expect(readyRead, label).toBeNull()
        continue
      }
      expect(readyRead, label).not.toBeNull()
      const [start, end] = readyRead!
      expect(
        start < expected && expected <= end,
        `${label}: [${start}, ${end}) vs ${expected}`
      ).toBe(true)
    }
  })

  it.each(OPENCODE_TIMED)('%s: a zsh launch in front moves nothing but the offset', (name) => {
    const walk = WALKS['render-cursor-after-bracketed-paste']!
    const data = readTimedRuntimeFixture(name).chunks.join('')
    const alone = walkReadyEnd(data, walk)
    expect(alone).not.toBeNull()
    expect(walkReadyEnd(ZSH_LAUNCH_PROLOGUE + data, walk)).toBe(ZSH_LAUNCH_PROLOGUE.length + alone!)
    const agentRowEnd = (stream: string): number | undefined =>
      scanReadyRead(
        'opencode-agent-row',
        splitAt(stream, () => 1)
      )?.[1]
    expect(agentRowEnd(ZSH_LAUNCH_PROLOGUE + data)).toBe(
      ZSH_LAUNCH_PROLOGUE.length + agentRowEnd(data)!
    )
  })
})
