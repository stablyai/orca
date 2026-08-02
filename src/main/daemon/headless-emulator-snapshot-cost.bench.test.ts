import { describe, expect, it } from 'vitest'
import { performance } from 'node:perf_hooks'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HeadlessEmulator } from './headless-emulator'

// Benchmark harness for issue #5096 (terminal output delay / UI lag growing
// with session history). Run with:
//   ORCA_TERMINAL_PERF_BENCH=1 pnpm vitest run \
//     src/main/daemon/headless-emulator-snapshot-cost.bench.test.ts \
//     --config config/vitest.config.ts
//
// Why these measurements: during an active agent session every PTY chunk marks
// the session dirty, so daemon-pty-adapter checkpoints every 5s. getSnapshot()
// serializes the full headless buffer synchronously on the daemon event loop
// (stalling the PTY pump), and history-manager JSON.stringifies the result on
// the Electron main process (stalling input IPC). Both stalls scale with
// buffer content, which matches the report that clearing history fixes the lag.
const benchEnabled = process.env.ORCA_TERMINAL_PERF_BENCH === '1'

const COLS = 200
const ROWS = 50
const DAEMON_DEFAULT_SCROLLBACK = 5_000
const RENDERER_SCALE_SCROLLBACK = 50_000
const SNAPSHOT_ITERATIONS = 5
const FILL_WRITE_CHUNK_LINES = 200

type BenchRow = {
  scenario: string
  bufferRows: number
  fillMs: number
  snapshotMedianMs: number
  snapshotMaxMs: number
  snapshotBytes: number
  checkpointStringifyMs: number
  reflowMs: number
}

function agentTranscriptLine(index: number): string {
  // Mimic agent TUI transcripts: SGR colors, tool-call box drawing, varied
  // widths — serialized cost depends on attribute churn, not just row count.
  const color = 30 + (index % 8)
  const variant = index % 4
  if (variant === 0) {
    return `\x1b[1;${color}m● Tool call ${index}\x1b[0m \x1b[2m(src/example/file-${index % 97}.ts)\x1b[0m\r\n`
  }
  if (variant === 1) {
    return `\x1b[${color}m│\x1b[0m  ${'response token '.repeat(1 + (index % 7))}#${index}\r\n`
  }
  if (variant === 2) {
    return `\x1b[38;5;${index % 256}m${'═'.repeat(20 + (index % 60))}\x1b[0m\r\n`
  }
  return `  \x1b[32m+\x1b[0m line ${index}: ${'x'.repeat(10 + (index % 80))}\r\n`
}

function fillEmulator(emulator: HeadlessEmulator, lines: number): number {
  const start = performance.now()
  for (let offset = 0; offset < lines; offset += FILL_WRITE_CHUNK_LINES) {
    let chunk = ''
    const end = Math.min(offset + FILL_WRITE_CHUNK_LINES, lines)
    for (let index = offset; index < end; index += 1) {
      chunk += agentTranscriptLine(index)
    }
    void emulator.write(chunk)
  }
  return performance.now() - start
}

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

function measureCheckpointStringify(emulator: HeadlessEmulator): number {
  const snapshot = emulator.getSnapshot()
  const start = performance.now()
  // Mirrors history-manager.ts checkpoint(): the payload main stringifies and
  // writes to disk every 5s per dirty session.
  JSON.stringify({
    snapshotAnsi: snapshot.snapshotAnsi,
    scrollbackAnsi: snapshot.scrollbackAnsi,
    rehydrateSequences: snapshot.rehydrateSequences,
    cwd: snapshot.cwd,
    cols: snapshot.cols,
    rows: snapshot.rows,
    modes: snapshot.modes,
    scrollbackLines: snapshot.scrollbackLines,
    checkpointedAt: new Date().toISOString()
  })
  return performance.now() - start
}

function measureReflow(emulator: HeadlessEmulator): number {
  const start = performance.now()
  emulator.resize(COLS - 1, ROWS)
  emulator.resize(COLS, ROWS)
  return performance.now() - start
}

function runScenario(scenario: string, scrollback: number, fillLines: number): BenchRow {
  const emulator = new HeadlessEmulator({ cols: COLS, rows: ROWS, scrollback })
  try {
    const fillMs = fillEmulator(emulator, fillLines)
    const durations: number[] = []
    let snapshotBytes = 0
    for (let iteration = 0; iteration < SNAPSHOT_ITERATIONS; iteration += 1) {
      const start = performance.now()
      const snapshot = emulator.getSnapshot()
      durations.push(performance.now() - start)
      snapshotBytes = Buffer.byteLength(snapshot.snapshotAnsi, 'utf8')
    }
    const checkpointStringifyMs = measureCheckpointStringify(emulator)
    const reflowMs = measureReflow(emulator)
    return {
      scenario,
      bufferRows: fillLines,
      fillMs: round(fillMs),
      snapshotMedianMs: round(medianOf(durations)),
      snapshotMaxMs: round(Math.max(...durations)),
      snapshotBytes,
      checkpointStringifyMs: round(checkpointStringifyMs),
      reflowMs: round(reflowMs)
    }
  } finally {
    emulator.dispose()
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

// Why a file: vitest's default reporter swallows console output from passing
// tests; the measurements are the deliverable of this harness.
function writeBenchReport(fileName: string, report: unknown): void {
  const reportPath = join(tmpdir(), fileName)
  writeFileSync(reportPath, JSON.stringify(report, null, 2))
  process.stdout.write(`\n[bench] report written to ${reportPath}\n`)
}

// Why: models the daemon event loop. PTY chunks and the checkpoint work share
// one thread in the daemon process; the worst inter-chunk gap during a
// checkpoint is the output latency a user sees when a tick lands.
// 'snapshot' models the pre-#5096 design (full serialize per tick);
// 'incremental-take' models the replacement (drain pending records — the
// daemon-side cost of the takePendingOutput RPC).
async function measureStreamInterference(
  checkpointAtChunk: number | null,
  mode: 'snapshot' | 'incremental-take' = 'snapshot'
): Promise<{
  maxGapMs: number
  checkpointMs: number
}> {
  const emulator = new HeadlessEmulator({
    cols: COLS,
    rows: ROWS,
    scrollback: DAEMON_DEFAULT_SCROLLBACK
  })
  try {
    fillEmulator(emulator, DAEMON_DEFAULT_SCROLLBACK)
    const totalChunks = 200
    let pending: { kind: 'output'; data: string }[] = []
    let maxGapMs = 0
    let checkpointMs = 0
    let lastChunkAt = performance.now()
    for (let chunk = 0; chunk < totalChunks; chunk += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 2))
      const now = performance.now()
      maxGapMs = Math.max(maxGapMs, now - lastChunkAt)
      const line = agentTranscriptLine(chunk)
      void emulator.write(line)
      pending.push({ kind: 'output', data: line })
      lastChunkAt = performance.now()
      if (chunk === checkpointAtChunk) {
        const start = performance.now()
        if (mode === 'snapshot') {
          emulator.getSnapshot()
        } else {
          const taken = pending
          pending = []
          JSON.stringify({ records: taken, seq: 1, overflowed: false, snapshot: null })
        }
        checkpointMs = performance.now() - start
      }
    }
    return { maxGapMs: round(maxGapMs), checkpointMs: round(checkpointMs) }
  } finally {
    emulator.dispose()
  }
}

describe.skipIf(!benchEnabled)('headless emulator snapshot cost (issue #5096 harness)', () => {
  it('measures daemon checkpoint cost across history sizes', () => {
    const results: BenchRow[] = [
      runScenario('empty buffer', DAEMON_DEFAULT_SCROLLBACK, 0),
      runScenario('short session (1k rows)', DAEMON_DEFAULT_SCROLLBACK, 1_000),
      runScenario('daemon cap (5k rows)', DAEMON_DEFAULT_SCROLLBACK, DAEMON_DEFAULT_SCROLLBACK),
      runScenario('renderer-scale (50k rows)', RENDERER_SCALE_SCROLLBACK, RENDERER_SCALE_SCROLLBACK)
    ]

    writeBenchReport('orca-headless-snapshot-bench.json', {
      interpretation:
        'snapshotMedianMs stalls the daemon PTY pump per 5s checkpoint; ' +
        'checkpointStringifyMs stalls Electron main (input IPC); ' +
        'reflowMs models the renderer-side resize/reflow stall at the same fill.',
      cols: COLS,
      rows: ROWS,
      results
    })

    expect(results).toHaveLength(4)
    for (const row of results) {
      expect(row.snapshotMedianMs).toBeGreaterThanOrEqual(0)
    }
  }, 300_000)

  it('measures PTY pump stall when a checkpoint lands mid-stream', async () => {
    const baseline = await measureStreamInterference(null)
    const withFullSnapshot = await measureStreamInterference(100, 'snapshot')
    const withIncrementalTake = await measureStreamInterference(100, 'incremental-take')
    writeBenchReport('orca-checkpoint-interference-bench.json', {
      interpretation:
        'maxGapMs is the worst chunk-to-chunk forwarding delay on the simulated daemon loop. ' +
        'withFullSnapshot models the old per-5s full serialize; withIncrementalTake models ' +
        'the incremental checkpoint take that replaced it.',
      baseline,
      withFullSnapshot,
      withIncrementalTake
    })
    expect(withFullSnapshot.checkpointMs).toBeGreaterThan(0)
  }, 300_000)
})
