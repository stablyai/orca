// Every recorded agent screen the readiness census replays, with the grid and process it ran under.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TuiAgent } from '../../shared/tui-agent'
import { GROK_STARTUP_PTY_TRACE } from '../../shared/__fixtures__/grok-startup-pty-trace'
import { GROK_INLINE_STARTUP_PTY_TRACE } from '../../shared/__fixtures__/grok-inline-startup-pty-trace'
import type { GrokStartupTraceChunk } from '../../shared/__fixtures__/grok-startup-pty-trace'
import { splitTranscriptIntoChunks } from './agent-transcript-replay-test-harness'

export type CensusTranscript = {
  name: string
  /** Null for a non-agent recording, which only the agent-unknown pane replays. */
  agent: TuiAgent | null
  foregroundProcess: string
  cols: number
  rows: number
  /** Recorded PTY chunk boundaries when the capture kept them, else the replay harness's. */
  chunks: () => readonly string[]
}

/** One replay: a recording on a pane that knows its agent, or on an agent-unknown pane. */
export type CensusPane = { transcript: CensusTranscript; pane: 'agent' | 'unknown' }

type Recorder = { agent: TuiAgent | null; foregroundProcess: string; grid?: Grid }
type Grid = { cols: number; rows: number }

const RUNTIME_FIXTURES = join(__dirname, '__fixtures__')
const DAEMON_FIXTURES = join(__dirname, '..', 'daemon', '__fixtures__', 'pty-transcripts')

// Why by name prefix: an unlisted recording fails here instead of escaping the census.
const RUNTIME_RECORDERS: readonly (readonly [string, Recorder])[] = [
  ['antigravity-', { agent: 'antigravity', foregroundProcess: 'agy' }],
  ['claude-', { agent: 'claude', foregroundProcess: 'claude' }],
  ['cline-', { agent: 'cline', foregroundProcess: 'cline' }],
  ['codex-', { agent: 'codex', foregroundProcess: 'codex' }],
  // Clipboard copies of screens with no meta.json, at the runtime emulator's default grid.
  [
    'cursor-agent-',
    { agent: 'cursor', foregroundProcess: 'cursor-agent', grid: { cols: 80, rows: 24 } }
  ],
  ['dsh-', { agent: 'dsh', foregroundProcess: 'dsh-tui' }],
  ['freebuff-', { agent: 'freebuff', foregroundProcess: 'freebuff' }],
  ['hermes-', { agent: 'hermes', foregroundProcess: 'hermes' }],
  ['muse-', { agent: 'muse', foregroundProcess: 'muse' }],
  ['omp-', { agent: 'omp', foregroundProcess: 'omp' }],
  ['prime-agent-', { agent: 'prime-agent', foregroundProcess: 'prime-agent' }],
  ['qoder-cn-', { agent: 'qoder-cn', foregroundProcess: 'qoderclicn' }],
  ['qoder-', { agent: 'qoder', foregroundProcess: 'qodercli' }],
  ['zcode-', { agent: 'zcode', foregroundProcess: 'zcode' }]
]

// less, nano and vim are non-agent controls for the agent-unknown pane.
const DAEMON_RECORDERS: Readonly<Record<string, Recorder>> = {
  opencode: { agent: 'opencode', foregroundProcess: 'opencode' },
  'opencode-run': { agent: 'opencode', foregroundProcess: 'opencode' },
  less: { agent: null, foregroundProcess: 'less' },
  nano: { agent: null, foregroundProcess: 'nano' },
  vim: { agent: null, foregroundProcess: 'vim' }
}

function readGrid(dir: string, name: string): Grid {
  const meta: unknown = JSON.parse(readFileSync(join(dir, `${name}.meta.json`), 'utf8'))
  if (
    typeof meta !== 'object' ||
    meta === null ||
    !('cols' in meta) ||
    !('rows' in meta) ||
    typeof meta.cols !== 'number' ||
    typeof meta.rows !== 'number'
  ) {
    throw new Error(`${name}: meta.json has no grid`)
  }
  return { cols: meta.cols, rows: meta.rows }
}

/** `<name>.timing.json` holds each recorded chunk as [ms since spawn, UTF-16 length]. */
function recordedChunks(dir: string, name: string): readonly string[] {
  const data = readFileSync(join(dir, `${name}.txt`), 'utf8')
  const timingPath = join(dir, `${name}.timing.json`)
  if (!existsSync(timingPath)) {
    return splitTranscriptIntoChunks(data)
  }
  const timing: unknown = JSON.parse(readFileSync(timingPath, 'utf8'))
  const lengths =
    typeof timing === 'object' && timing !== null && 'chunks' in timing ? timing.chunks : undefined
  if (!Array.isArray(lengths)) {
    throw new Error(`${name}: timing.json has no chunks`)
  }
  const chunks: string[] = []
  let offset = 0
  for (const entry of lengths) {
    const length: unknown = Array.isArray(entry) ? entry[1] : undefined
    if (typeof length !== 'number') {
      throw new Error(`${name}: malformed timing chunk`)
    }
    chunks.push(data.slice(offset, offset + length))
    offset += length
  }
  if (offset !== data.length) {
    throw new Error(`${name}: timing covers ${offset} of ${data.length} chars`)
  }
  return chunks
}

function recordedTranscripts(
  dir: string,
  prefix: string,
  recorderFor: (name: string) => Recorder | undefined
): CensusTranscript[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.txt'))
    .map((file) => file.slice(0, -'.txt'.length))
    .map((name) => {
      const recorder = recorderFor(name)
      if (!recorder) {
        throw new Error(
          `${name}: no census recorder; add one in readiness-census-transcript-catalog`
        )
      }
      const { cols, rows } = recorder.grid ?? readGrid(dir, name)
      return {
        name: `${prefix}${name}`,
        agent: recorder.agent,
        foregroundProcess: recorder.foregroundProcess,
        cols,
        rows,
        chunks: () => recordedChunks(dir, name)
      }
    })
}

// Why filler of the recorded length: the trace elides marker-free animation frames to a byte count.
function grokTranscript(name: string, trace: readonly GrokStartupTraceChunk[]): CensusTranscript {
  return {
    name: `grok/${name}`,
    agent: 'grok',
    foregroundProcess: 'grok',
    // Both traces record 120x30 (see their headers).
    cols: 120,
    rows: 30,
    chunks: () => trace.map((chunk) => chunk.data ?? 'x'.repeat(chunk.bytes ?? 0))
  }
}

export const CENSUS_TRANSCRIPTS: readonly CensusTranscript[] = [
  ...recordedTranscripts(
    RUNTIME_FIXTURES,
    '',
    (name) => RUNTIME_RECORDERS.find(([prefix]) => name.startsWith(prefix))?.[1]
  ),
  ...recordedTranscripts(DAEMON_FIXTURES, 'daemon/', (name) => DAEMON_RECORDERS[name]),
  grokTranscript('startup', GROK_STARTUP_PTY_TRACE),
  grokTranscript('inline-startup', GROK_INLINE_STARTUP_PTY_TRACE)
].toSorted((a, b) => a.name.localeCompare(b.name))

export const CENSUS_PANES: readonly CensusPane[] = CENSUS_TRANSCRIPTS.flatMap((transcript) => [
  ...(transcript.agent ? [{ transcript, pane: 'agent' as const }] : []),
  { transcript, pane: 'unknown' as const }
])

export function censusPaneSubject({ transcript, pane }: CensusPane): string {
  return `transcript/${transcript.name}@${pane}`
}

/** Test files the replays spread across; each file is one vitest worker. */
export const CENSUS_SHARD_COUNT = 6

/** Shard `shard`'s (1-based) replays: longest first onto the lightest shard, so one long recording
 *  does not land beside others. */
export function censusShard(shard: number): CensusPane[] {
  const shards = Array.from(
    { length: CENSUS_SHARD_COUNT },
    (): { frames: number; panes: CensusPane[] } => ({
      frames: 0,
      panes: []
    })
  )
  const byLength = CENSUS_PANES.map((pane) => ({
    pane,
    frames: pane.transcript.chunks().length
  })).toSorted((a, b) => b.frames - a.frames)
  for (const { pane, frames } of byLength) {
    const lightest = shards.reduce((min, shard) => (shard.frames < min.frames ? shard : min))
    lightest.frames += frames
    lightest.panes.push(pane)
  }
  return shards[shard - 1]?.panes ?? []
}
