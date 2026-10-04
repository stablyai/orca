import { createHash } from 'node:crypto'
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
// build's did — pre-existing serializer limitations, not regressions (verified
// with ORCA_OLD_SERIALIZE_ADDON): the live SGR pen leaks into the alt buffer, and
// an alt buffer first entered after a shrink keeps hidden scrollback. Shrink when one is fixed.
const KNOWN_PREEXISTING_I2_FAILURES: Record<string, number> = {
  less: 6,
  nano: 2,
  opencode: 5,
  // Captured boots expose the existing background/cursor restore loss; serializer code is unchanged.
  'opencode-1-18-32-timed-boot-hidden-pane': 16,
  'opencode-1-18-32-timed-boot-slow': 16,
  'opencode-1-18-32-timed-first-launch': 16,
  'opencode-2-0-18-timed-boot-hidden-pane': 14,
  // Shrink leaves the cursor one column short; also present in the pre-Qoder serializer.
  'qoder-no-account': 2,
  'qoder-ready': 2,
  // Prior efbf651c7bb2 also clamps the restored right-margin cursor (120→119); I1/I3 hold.
  'antigravity-windows-command-approval': 4,
  // Codex 0.157 header border restores with an extra attribute bit (STA-8628 fixtures).
  'codex-0157-config-override-embedded-warning': 22,
  'codex-0157-effort-override-embedded-warning': 4,
  'codex-0157-no-daemon-effort-override': 16,
  'codex-0157-plain-ready': 18,
  // Fresh-home 0.157/0.158 captures: the live pen's true-colour fg/bg leaks onto restored cells.
  'codex-0157-fresh-home-daemon-install': 48,
  'codex-0158-fresh-home-greeting': 9,
  'codex-0158-model-announcement-dialog': 8,
  // Codex 0.157/0.158 startup-dialog captures: the same live-pen true-colour leak onto restored cells.
  'codex-0157-update-available-dialog': 26,
  'codex-0158-update-available-dialog': 8,
  'codex-0157-hooks-review-dialog': 24,
  'codex-0158-hooks-review-dialog': 8,
  'codex-0157-model-retired-dialog': 22,
  'codex-0158-model-retired-dialog': 6,
  // Same extra dim bit on the 0.157/0.158 header row (STA-8834 fixtures).
  'codex-0-157-1-update-dialog': 16,
  'codex-0-157-1-timed-sleep-turn': 6,
  'codex-0-158-0-approval': 12,
  'codex-0-158-0-timed-turn': 20,
  'codex-0-158-0-trustprompt': 36,
  'claude-dialog-trust-workspace-answered': 13,
  // DSH-TUI's whale intro paints whole rows of 24-bit background, and every one of this
  // transcript's divergences is the same shape: `visible-grid row=0`, a true-colour
  // background that the round trip does not restore to default. Verified as upstream, not a
  // regression, by replaying it against the previous build
  // (`build-serialize-addon-at-ref.mjs --ref origin/main`): I1 and I3 both hold.
  'dsh-tui-ready-no-key': 10,
  // Hermes banner cells restore with an extra bold bit under the jitter schedule.
  'hermes-tui-ready': 2,
  // STA-8741 agy/Cline/Prime captures, serializer untouched: the same true-colour background
  // left on restored cells as DSH, plus Prime's cursor row after its alternate-screen repaints.
  'antigravity-1-2-14-busy-thinking': 2,
  'antigravity-1-2-14-command-palette': 4,
  'antigravity-1-2-14-draft': 4,
  'antigravity-1-2-14-model-picker': 2,
  'antigravity-1-2-14-picker-dismissed': 2,
  'antigravity-1-2-14-ready': 12,
  'antigravity-1-2-14-ready-80x24': 2,
  'antigravity-1-2-14-ready-accept-edits': 4,
  'antigravity-1-2-14-ready-plan': 4,
  'antigravity-1-2-14-trust-dialog': 26,
  'cline-3-0-66-busy-streaming': 6,
  'cline-3-0-66-draft': 6,
  'cline-3-0-66-permission': 6,
  'cline-3-0-66-promo': 15,
  'cline-3-0-66-ready': 11,
  'cline-3-0-66-ready-80x24': 2,
  'cline-3-0-66-slash-menu': 6,
  'cline-3-0-66-turn-ended': 10,
  'prime-agent-0-9-5-ready': 18,
  'prime-agent-0-9-5-turn': 4,
  'prime-agent-0-9-8-busy-streaming': 16,
  'prime-agent-0-9-8-draft': 10,
  'prime-agent-0-9-8-ready': 22,
  'prime-agent-0-9-8-ready-80x24': 16,
  'prime-agent-0-9-8-ready-after-question': 2,
  'prime-agent-0-9-8-slash-menu': 34,
  'prime-agent-0-9-8-tool-turn': 40,
  'prime-agent-0-9-8-trace-question': 4,
  'prime-agent-0-9-8-turn-ended': 24,
  // OMP 18.4.5 captures, serializer untouched: after a shrink the restored cursor sits one column
  // short, as for Qoder. The unscrubbed captures diverge identically, so the scrub is not the cause.
  'omp-18-composer': 2,
  'omp-18-composer-narrow': 7,
  'omp-18-setup': 6
}

// Exact resize checkpoints and full GridDiff hashes from base 6835b9b4e3ea, not this branch.
const FREEBUFF_BASELINE: Record<string, readonly string[]> = JSON.parse(
  readFileSync(join(__dirname, '__fixtures__/freebuff-serialize-baseline.json'), 'utf8')
)

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
      const failureSignatures: string[] = []
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
              if (check.gridDiff.new) {
                const signature = createHash('sha256')
                  .update(JSON.stringify(check.gridDiff.new))
                  .digest('hex')
                failureSignatures.push(
                  `${schedule}/${conpty}/${seed}/${check.stepIndex}:${signature}`
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
      if (SEEDS === 2 && transcript.name === 'antigravity-windows-command-approval') {
        expect(failureSignatures).toEqual([
          'shrink-grow/false/1/30:ee4f2be236723b8d30e4c58413e1e2200e8c209cfc2b32c35b7caf0f6569c5bd',
          'shrink-grow/false/2/35:ee4f2be236723b8d30e4c58413e1e2200e8c209cfc2b32c35b7caf0f6569c5bd',
          'shrink-grow/true/1/30:ee4f2be236723b8d30e4c58413e1e2200e8c209cfc2b32c35b7caf0f6569c5bd',
          'shrink-grow/true/2/35:ee4f2be236723b8d30e4c58413e1e2200e8c209cfc2b32c35b7caf0f6569c5bd'
        ])
      }
      if (SEEDS === 2 && transcript.name === 'hermes-tui-ready') {
        expect(failureSignatures).toEqual([
          'jitter/false/2/34:0db2561506ff28d2e83276b07bc8684541957f61e488b6f8081627e8cad80c63',
          'jitter/true/2/34:0db2561506ff28d2e83276b07bc8684541957f61e488b6f8081627e8cad80c63'
        ])
      }
      // The pre-#22586 serializer has these same row-1 bold diffs on the untouched capture.
      if (SEEDS === 2 && transcript.name === 'dsb-6-9-0-folder') {
        expect(failureSignatures).toEqual([
          'jitter/false/2/19:2050835176269320209c56be5ae9e525424635dfca511d44d3911d3a22ba9d27',
          'jitter/true/2/19:2050835176269320209c56be5ae9e525424635dfca511d44d3911d3a22ba9d27'
        ])
      } else if (SEEDS === 2 && transcript.name.startsWith('freebuff-')) {
        expect(failureSignatures).toEqual(FREEBUFF_BASELINE[transcript.name] ?? [])
      } else if (!OLD_ADDON_PATH && SEEDS === 2) {
        expect(counts['new-fail'] ?? 0).toBe(KNOWN_PREEXISTING_I2_FAILURES[transcript.name] ?? 0)
      }
    },
    600_000
  )
})
