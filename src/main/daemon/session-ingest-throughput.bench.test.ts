import { describe, expect, it } from 'vitest'
import { performance } from 'node:perf_hooks'
import { Session } from './session'
import type { SubprocessHandle } from './session-subprocess-handle'

// Enable ORCA_TERMINAL_PERF_BENCH=1 to isolate daemon ingest cost with terminal-pipeline-bench workloads.
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
    terminateOwnedTree: () => 'unavailable' as const,
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
  subprocess.emit(fixture.slice(0, 256 * 1024))
  session.takePendingOutput(false)
  const start = performance.now()
  let chunks = 0
  for (let i = 0; i < fixture.length; i += CHUNK) {
    subprocess.emit(fixture.slice(i, i + CHUNK))
    chunks++
    // Drain before overflow stops record accounting, or the benchmark understates steady-state cost.
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
    console.log(`\n[session-ingest] ${COLS}x${ROWS}\n  ${rows.join('\n  ')}`)
    expect(rows.length).toBe(2)
  })
})
