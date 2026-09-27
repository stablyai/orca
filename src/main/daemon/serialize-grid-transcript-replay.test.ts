import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mulberry32 } from '../../shared/agent-tui-ansi-fuzz-stream'
import type { SerializeFuzzCase, SerializeFuzzStep } from './serialize-grid-fuzz-stream'
import {
  loadOldSerializer,
  NEW_SERIALIZER,
  runSerializeFuzzCase,
  verdicts,
  type Verdict
} from './serialize-grid-roundtrip'

// Replays captured agent/TUI PTY transcripts through the serialize round trip
// under resize schedules the app never saw (a pane resized while hidden), and
// serializes at random chunk boundaries. With ORCA_OLD_SERIALIZE_ADDON set it
// also checks I1/I3 against the previous build; see serialize-grid.differential.fuzz.test.ts.
//   SERIALIZE_TRANSCRIPT_DIR=<dir>  also replay local, uncommitted captures (<name>.txt + .meta.json)
//   SERIALIZE_TRANSCRIPT_SEEDS=20   seeds per transcript × schedule (default 2)

const FIXTURE_DIRS = [
  join(__dirname, '../runtime/__fixtures__'),
  join(__dirname, '__fixtures__/pty-transcripts')
]
const EXTRA_DIR = process.env.SERIALIZE_TRANSCRIPT_DIR
const OLD_ADDON_PATH = process.env.ORCA_OLD_SERIALIZE_ADDON
const SEEDS = Math.max(1, Number(process.env.SERIALIZE_TRANSCRIPT_SEEDS) || 2)

// Checkpoints (default seeds) whose new replay diverges exactly as the previous
// build's did — pre-existing upstream limitations, not regressions (verified
// with ORCA_OLD_SERIALIZE_ADDON). Shrink when one is fixed.
const KNOWN_PREEXISTING_I2_FAILURES: Record<string, number> = { less: 6, nano: 2, opencode: 5 }

type Transcript = { name: string; data: string; cols: number; rows: number }
type Schedule = 'none' | 'shrink' | 'shrink-grow' | 'jitter'
const SCHEDULES: readonly Schedule[] = ['none', 'shrink', 'shrink-grow', 'jitter']

function readTranscripts(dir: string): Transcript[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.txt'))
    .map((file) => {
      const metaPath = join(dir, file.replace(/\.txt$/, '.meta.json'))
      const meta: { cols?: number; rows?: number } = existsSync(metaPath)
        ? JSON.parse(readFileSync(metaPath, 'utf8'))
        : {}
      return {
        name: basename(file, '.txt'),
        data: readFileSync(join(dir, file), 'utf8'),
        cols: meta.cols ?? 120,
        rows: meta.rows ?? 40
      }
    })
}

// Never splits a surrogate pair: PTY bytes reach JS as whole code points.
function chunk(data: string, rng: () => number, count: number): string[] {
  const chunks: string[] = []
  let start = 0
  while (start < data.length) {
    let end = Math.min(data.length, start + 1 + Math.floor(rng() * ((2 * data.length) / count)))
    const code = data.charCodeAt(end - 1)
    end += end < data.length && code >= 0xd800 && code <= 0xdbff ? 1 : 0
    chunks.push(data.slice(start, end))
    start = end
  }
  return chunks
}

function buildReplayCase(
  transcript: Transcript,
  schedule: Schedule,
  conpty: boolean,
  seed: number
): SerializeFuzzCase {
  const rng = mulberry32(seed)
  const chunks = chunk(transcript.data, rng, 24)
  const { cols, rows } = transcript
  const narrow = Math.max(8, Math.floor(cols * (0.4 + rng() * 0.4)))
  const steps: SerializeFuzzStep[] = []
  chunks.forEach((data, i) => {
    const at = i / chunks.length
    const next = (i + 1) / chunks.length
    if (schedule === 'shrink' && at <= 0.5 && next > 0.5) {
      steps.push({ kind: 'resize', cols: narrow, rows })
    }
    if (schedule === 'shrink-grow' && at <= 0.3 && next > 0.3) {
      steps.push({ kind: 'resize', cols: narrow, rows: Math.max(4, rows - 6) })
    }
    if (schedule === 'shrink-grow' && at <= 0.7 && next > 0.7) {
      steps.push({ kind: 'resize', cols, rows })
    }
    if (schedule === 'jitter' && rng() < 0.25) {
      steps.push({ kind: 'resize', cols: Math.max(8, cols + Math.floor(rng() * 21) - 14), rows })
    }
    steps.push({ kind: 'write', data })
    if (rng() < 0.15) {
      steps.push({ kind: 'check', scrollback: rng() < 0.5 ? 5000 : 0 })
    }
  })
  steps.push({ kind: 'check', scrollback: 5000 })
  return {
    seed,
    category: conpty ? 'conpty' : 'normal',
    cols,
    rows,
    sourceScrollback: 1000,
    steps
  }
}

describe('serialize round trip over captured PTY transcripts', () => {
  const transcripts = [
    ...FIXTURE_DIRS.flatMap(readTranscripts),
    ...(EXTRA_DIR ? readTranscripts(EXTRA_DIR) : [])
  ]
  const serializers = OLD_ADDON_PATH
    ? [loadOldSerializer(OLD_ADDON_PATH), NEW_SERIALIZER]
    : [NEW_SERIALIZER]

  it.each(transcripts.map((t) => [t.name, t] as const))(
    '%s: no I1 byte diff and no I3 regression under resize schedules',
    async (_name, transcript) => {
      const counts: Partial<Record<Verdict | 'checks', number>> = {}
      const blocking: string[] = []
      for (const schedule of SCHEDULES) {
        for (const conpty of [false, true]) {
          for (let seed = 1; seed <= SEEDS; seed++) {
            const testCase = buildReplayCase(transcript, schedule, conpty, seed)
            const run = await runSerializeFuzzCase(testCase, serializers)
            expect(run.sourceCrash).toBeNull()
            for (const check of run.checks) {
              counts.checks = (counts.checks ?? 0) + 1
              if (process.env.SERIALIZE_FUZZ_REPORT === '1' && check.gridDiff.new) {
                const d = check.gridDiff.new
                console.log(
                  `  ${transcript.name} ${schedule} conpty=${conpty} seed=${seed}: ${d.stage} row=${d.row} ${JSON.stringify(d.expected)?.slice(0, 160)} -> ${JSON.stringify(d.actual)?.slice(0, 160)}`
                )
              }
              for (const verdict of verdicts(check, serializers.length > 1)) {
                counts[verdict] = (counts[verdict] ?? 0) + 1
                if (verdict === 'i1-bytes-differ' || verdict === 'regression') {
                  blocking.push(
                    `${verdict} schedule=${schedule} conpty=${conpty} seed=${seed} step=${check.stepIndex} new=${JSON.stringify(check.gridDiff.new)?.slice(0, 400)}`
                  )
                }
              }
            }
          }
        }
      }
      if (process.env.SERIALIZE_FUZZ_REPORT === '1') {
        console.log(`${transcript.name} ${JSON.stringify(counts)}`)
      }
      expect(blocking).toEqual([])
      if (!OLD_ADDON_PATH && SEEDS === 2) {
        expect(counts['new-fail'] ?? 0).toBe(KNOWN_PREEXISTING_I2_FAILURES[transcript.name] ?? 0)
      }
    },
    600_000
  )
})
