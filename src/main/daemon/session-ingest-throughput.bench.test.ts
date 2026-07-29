import { describe, expect, it } from 'vitest'
import { performance } from 'node:perf_hooks'
import { Session, type SubprocessHandle } from './session'

// Benchmark harness for the terminal performance initiative: measures the
// daemon-side ingest rate (Session.handleSubprocessData -> HeadlessEmulator
// write + pending-output recording + client fanout) for the same workload
// shapes as tools/benchmarks/terminal-pipeline-bench.mjs. Bare headless
// xterm parses these at ~80-100 MB/s; the end-to-end Orca pipeline measured
// 2-15 MB/s (baseline-jul02) — this isolates the daemon layer's share.
// Run with:
//   ORCA_TERMINAL_PERF_BENCH=1 pnpm vitest run \
//     src/main/daemon/session-ingest-throughput.bench.test.ts \
//     --config config/vitest.config.ts
const benchEnabled = process.env.ORCA_TERMINAL_PERF_BENCH === '1'

const COLS = 114
const ROWS = 85
const TARGET_BYTES = 10 * 1024 * 1024
const CHUNK = 64 * 1024

function asciiLog(targetBytes: number): string {
  const parts: string[] = []
  let bytes = 0
  let line = 0
  while (bytes < targetBytes) {
    line++
    const s = `\x1b[32m[build ${String(line).padStart(6, '0')}]\x1b[0m compile transform resolve bundle emit chunk module (${line % 5000}ms)\r\n`
    parts.push(s)
    bytes += s.length
  }
  return parts.join('')
}

function agentTui(targetBytes: number): string {
  const statusRows = 10
  const parts: string[] = []
  let bytes = 0
  let frame = 0
  let painted = false
  const push = (s: string): void => {
    parts.push(s)
    bytes += Buffer.byteLength(s, 'utf8')
  }
  while (bytes < targetBytes) {
    frame++
    push('\x1b[?2026h')
    if (painted) {
      push(`\x1b[${statusRows}A\x1b[0J`)
    }
    push(`\x1b[2m●\x1b[0m transcript line for frame ${frame} with some words\r\n`)
    for (let r = 0; r < statusRows; r++) {
      push(
        `\x1b[38;5;${33 + (r % 6)}m⠼ task ${frame % 100}·${r}\x1b[0m ${'▇'.repeat((frame + r) % 40)}\r\n`
      )
    }
    painted = true
    push('\x1b[?2026l')
  }
  return parts.join('')
}

function makeSubprocess(): SubprocessHandle & { emit: (data: string) => void } {
  let onData: ((data: string) => void) | null = null
  return {
    pid: 4242,
    getForegroundProcess: () => 'bench',
    write: () => {},
    resize: () => {},
    kill: () => {},
    forceKill: () => {},
    signal: () => {},
    onData: (cb) => {
      onData = cb
    },
    onExit: () => {},
    dispose: () => {},
    emit: (data: string) => onData?.(data)
  }
}

function ingest(fixture: string, drainPendingEveryChunks: number | null): number {
  const subprocess = makeSubprocess()
  const session = new Session({
    sessionId: 'bench',
    cols: COLS,
    rows: ROWS,
    subprocess,
    shellReadySupported: false
  })
  session.attachClient({ onData: () => {}, onExit: () => {} })
  // Warmup primes JIT paths.
  subprocess.emit(fixture.slice(0, 256 * 1024))
  session.takePendingOutput(false)
  const start = performance.now()
  let chunks = 0
  for (let i = 0; i < fixture.length; i += CHUNK) {
    subprocess.emit(fixture.slice(i, i + CHUNK))
    chunks++
    // Why: without periodic takes the 2MB pending cap overflows and recording
    // short-circuits, understating the real steady-state cost. The 5s adapter
    // tick drains in production; drain per ~1.5MB approximates a hot session.
    if (drainPendingEveryChunks && chunks % drainPendingEveryChunks === 0) {
      session.takePendingOutput(false)
    }
  }
  const ms = performance.now() - start
  session.dispose()
  return ms
}

describe.skipIf(!benchEnabled)('daemon session ingest throughput', () => {
  it('measures MB/s per workload shape', () => {
    const rows: string[] = []
    for (const [name, fixture] of [
      ['ascii-log', asciiLog(TARGET_BYTES)],
      ['agent-tui', agentTui(TARGET_BYTES)]
    ] as const) {
      const bytes = Buffer.byteLength(fixture, 'utf8')
      const ms = ingest(fixture, 24)
      const rate = bytes / 1024 / 1024 / (ms / 1000)
      rows.push(
        `${name}: ${rate.toFixed(1)} MB/s (${ms.toFixed(0)}ms for ${(bytes / 1024 / 1024).toFixed(1)}MB)`
      )
    }
    // eslint-disable-next-line no-console -- bench harness output
    console.log(`\n[session-ingest] ${COLS}x${ROWS}\n  ${rows.join('\n  ')}`)
    expect(rows.length).toBe(2)
  })
})
