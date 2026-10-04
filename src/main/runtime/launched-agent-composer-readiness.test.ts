import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDraftPasteReadyScanner } from '../../shared/draft-paste-ready-scanner'
import type { TuiAgent } from '../../shared/tui-agent'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import {
  readRuntimeFixture,
  readTimedRuntimeFixture,
  replayTranscript
} from './agent-transcript-replay-test-harness'
import {
  getLaunchedAgentReadinessLane,
  type LaunchedAgentReadinessLane
} from './launched-agent-composer-readiness'

// Why a full Record: adding a TuiAgent fails to compile here until someone decides whether its
// worker start waits for a captured input-box marker, and a row that gains or loses evidence
// shows up in review.
const EXPECTED_LANES: Record<TuiAgent, LaunchedAgentReadinessLane> = {
  zcode: 'composer-marker',
  opencode: 'composer-marker',
  opencode2: 'composer-marker',
  // mimo-code shares OpenCode's signal by parity only; no mimo boot has been recorded.
  'mimo-code': 'tui-idle',
  // Grok's inline mode never fires its marker; its marker is not proven at the box for every mode.
  grok: 'tui-idle',
  dsh: 'tui-idle',
  reasonix: 'tui-idle',
  codex: 'tui-idle',
  cursor: 'tui-idle',
  pi: 'tui-idle',
  omp: 'tui-idle',
  droid: 'tui-idle',
  hermes: 'tui-idle',
  devin: 'tui-idle',
  claude: 'tui-idle',
  'claude-agent-teams': 'tui-idle',
  openclaude: 'tui-idle',
  gemini: 'tui-idle',
  antigravity: 'tui-idle',
  aider: 'tui-idle',
  openclaw: 'tui-idle',
  copilot: 'tui-idle',
  muse: 'tui-idle',
  qoder: 'tui-idle',
  'qoder-cn': 'tui-idle',
  codebuddy: 'tui-idle',
  autohand: 'tui-idle',
  ante: 'tui-idle',
  trae: 'tui-idle',
  'prime-agent': 'tui-idle',
  goose: 'tui-idle',
  amp: 'tui-idle',
  kilo: 'tui-idle',
  kiro: 'tui-idle',
  crush: 'tui-idle',
  aug: 'tui-idle',
  cline: 'tui-idle',
  codebuff: 'tui-idle',
  freebuff: 'tui-idle',
  'command-code': 'tui-idle',
  continue: 'tui-idle',
  kimi: 'tui-idle',
  'mistral-vibe': 'tui-idle',
  'qwen-code': 'tui-idle',
  rovo: 'tui-idle',
  jcode: 'tui-idle'
}

const FIXTURES = join(__dirname, '__fixtures__')
const OPENCODE_PLACEHOLDER = 'Ask anything'
const SYNCHRONIZED_UPDATE_END = '\x1b[?2026l'

const CITED_CAPTURES = Object.entries(TUI_AGENT_CONFIG).flatMap(([agent, row]) =>
  (row.composerReadyCaptures ?? []).map((capture) => [agent, capture] as const)
)

function isTuiAgent(agent: string): agent is TuiAgent {
  return agent in TUI_AGENT_CONFIG
}

function readSignal(agent: string) {
  if (!isTuiAgent(agent)) {
    throw new Error(`${agent} is not a TuiAgent`)
  }
  const signal = TUI_AGENT_CONFIG[agent].draftPasteReadySignal
  if (!signal) {
    throw new Error(`${agent} cites composer-ready captures but has no draftPasteReadySignal`)
  }
  return signal
}

/** Index of the first read the scanner reports ready on, or -1. */
function firstReadyRead(agent: string, reads: readonly string[]): number {
  const scanner = createDraftPasteReadyScanner(readSignal(agent))
  return reads.findIndex((read) => scanner.observe(read).ready)
}

function readReads(capture: string): string[] {
  if (existsSync(join(FIXTURES, `${capture}.timing.json`))) {
    return readTimedRuntimeFixture(capture).chunks
  }
  const data = readRuntimeFixture(capture)
  const reads: string[] = []
  for (let offset = 0; offset < data.length; offset += 4096) {
    reads.push(data.slice(offset, offset + 4096))
  }
  return reads
}

describe('which lane a freshly launched worker waits on', () => {
  it.each(Object.entries(EXPECTED_LANES))('%s: %s', (agent, lane) => {
    if (!isTuiAgent(agent)) {
      throw new Error(`${agent} is not a TuiAgent`)
    }
    expect(getLaunchedAgentReadinessLane(agent)).toBe(lane)
  })
})

describe('every capture a row cites proves its input-box marker', () => {
  it('cites at least the rows worker start moved', () => {
    expect(CITED_CAPTURES.map(([agent]) => agent)).toEqual(
      expect.arrayContaining(['zcode', 'opencode', 'opencode2'])
    )
  })

  it.each(CITED_CAPTURES)('%s: %s is committed with its sidecar', (_agent, capture) => {
    expect(existsSync(join(FIXTURES, `${capture}.txt`))).toBe(true)
    const meta: { platform?: string; command?: string[]; note?: string } = JSON.parse(
      readFileSync(join(FIXTURES, `${capture}.meta.json`), 'utf8')
    )
    expect(meta.platform).toEqual(expect.any(String))
    expect(meta.command?.length).toBeGreaterThan(0)
    expect(meta.note).toEqual(expect.any(String))
  })

  it.each(CITED_CAPTURES)("%s: the row's current signal fires on %s", (agent, capture) => {
    expect(firstReadyRead(agent, readReads(capture))).toBeGreaterThanOrEqual(0)
  })

  it.each(
    CITED_CAPTURES.filter(([agent]) => readSignal(agent) === 'render-cursor-after-bracketed-paste')
  )(
    '%s: the first ready read in %s is the one that shows the input box',
    async (agent, capture) => {
      const meta: { cols: number; rows: number } = JSON.parse(
        readFileSync(join(FIXTURES, `${capture}.meta.json`), 'utf8')
      )
      const { chunks } = readTimedRuntimeFixture(capture)
      const data = chunks.join('')
      // OpenCode paints its box in one synchronized update, shown when that update ends.
      const boxEnd = data.indexOf(SYNCHRONIZED_UPDATE_END, data.indexOf(OPENCODE_PLACEHOLDER))
      let boxRead = -1
      for (let index = 0, end = 0; index < chunks.length && boxRead === -1; index += 1) {
        end += chunks[index].length
        boxRead = end >= boxEnd + SYNCHRONIZED_UPDATE_END.length ? index : -1
      }
      let placeholderRead = -1
      let read = 0
      for await (const frame of replayTranscript(chunks, meta.cols, meta.rows)) {
        if (frame.screenLines.some((line) => line.includes(OPENCODE_PLACEHOLDER))) {
          placeholderRead = read
          break
        }
        read += 1
      }
      expect(placeholderRead).toBeGreaterThanOrEqual(0)
      expect(boxRead).toBeGreaterThanOrEqual(placeholderRead)
      expect(firstReadyRead(agent, chunks)).toBe(boxRead)
    }
  )
})
