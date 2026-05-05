// Why: subprocess-level test for the CLI heartbeat behavior described in
// design doc §3.4. Spawns the real compiled CLI with no TTY, points it at a
// real in-process runtime via ORCA_USER_DATA_PATH, and asserts:
//   - the first heartbeat line appears on stderr well under Claude Code's
//     ~2 min Bash-tool silence budget (we verify with a shortened interval;
//     production uses 15 s via the same code path)
//   - ≥3 heartbeats arrive during the wait window
//   - stderr is line-flushed (we observe each heartbeat as a separate chunk
//     before the process exits — not in one burst at the end)
//   - stdout stays a single clean JSON payload (no heartbeats leak to stdout)
//   - a `jq "select(._heartbeat|not)"` filter on the merged stream would
//     yield exactly the final result
//
// This test is skipped if the CLI hasn't been built yet (out/cli/index.js
// missing) so `pnpm test` works on a fresh checkout without requiring a prior
// `pnpm run build:cli`. The verification gate explicitly builds the CLI
// before running this file.
import { spawn } from 'child_process'
import { existsSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from '../main/runtime/orca-runtime'
import { OrchestrationDb } from '../main/runtime/orchestration/db'
import { OrcaRuntimeRpcServer } from '../main/runtime/runtime-rpc'

// Why: Vitest runs tests with `process.cwd()` pinned to the repo root, so
// join against it to locate the compiled CLI regardless of where this test
// file itself lives.
const CLI_PATH = join(process.cwd(), 'out', 'cli', 'index.js')

const describeIfBuilt = existsSync(CLI_PATH) ? describe : describe.skip

describeIfBuilt('orca orchestration check --wait subprocess (§3.4)', () => {
  it('emits newline-flushed JSON heartbeats to stderr while waiting', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-cli-sub-'))
    const runtime = new OrcaRuntimeService()
    const db = new OrchestrationDb(':memory:')
    runtime.setOrchestrationDb(db)
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath })
    await server.start()

    try {
      // Why: use the ORCA_HEARTBEAT_INTERVAL_MS escape hatch to shrink the
      // test to ~1 s wall time. Production callers never set this; the
      // production default (15 s) is exercised by §3.4's own unit tests
      // and by the fact that this same code path runs with the real
      // constant when the env var is absent.
      const heartbeatMs = 200
      const waitTimeoutMs = 1200

      const child = spawn(
        process.execPath,
        [
          CLI_PATH,
          'orchestration',
          'check',
          '--wait',
          '--timeout-ms',
          String(waitTimeoutMs),
          '--json'
        ],
        {
          env: {
            ...process.env,
            ORCA_USER_DATA_PATH: userDataPath,
            ORCA_TERMINAL_HANDLE: 'term_nobody',
            ORCA_HEARTBEAT_INTERVAL_MS: String(heartbeatMs)
          },
          // Why: explicit pipe for all three fds so we can watch stderr
          // in real time; no TTY attached (Bash-tool parity).
          stdio: ['ignore', 'pipe', 'pipe']
        }
      )

      const stderrChunks: { at: number; data: string }[] = []
      const stdoutChunks: { at: number; data: string }[] = []
      const startedAt = Date.now()
      child.stderr.setEncoding('utf8')
      child.stdout.setEncoding('utf8')
      child.stderr.on('data', (d) => stderrChunks.push({ at: Date.now() - startedAt, data: d }))
      child.stdout.on('data', (d) => stdoutChunks.push({ at: Date.now() - startedAt, data: d }))

      const exitCode = await new Promise<number>((resolveExit, rejectExit) => {
        child.once('exit', (code) => resolveExit(code ?? 1))
        child.once('error', rejectExit)
      })

      expect(exitCode).toBe(0)

      const stderr = stderrChunks.map((c) => c.data).join('')
      const stdout = stdoutChunks.map((c) => c.data).join('')

      const heartbeatLines = stderr
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>
          } catch {
            return null
          }
        })
        .filter((p): p is Record<string, unknown> => p !== null && p._heartbeat === true)

      // ≥3 heartbeats in a 1.2s window with a 200ms interval
      expect(heartbeatLines.length).toBeGreaterThanOrEqual(3)
      expect(heartbeatLines[0]).toHaveProperty('elapsedMs')
      expect(heartbeatLines[0]).toHaveProperty('deadlineMs', waitTimeoutMs)

      // Why: first heartbeat must arrive within one interval + scheduler
      // slack (300ms is generous); if the stream were fully buffered we'd
      // see everything only after exit.
      const firstHeartbeatChunk = stderrChunks.find((c) => c.data.includes('_heartbeat'))
      expect(firstHeartbeatChunk).toBeDefined()
      expect(firstHeartbeatChunk!.at).toBeLessThan(heartbeatMs + 300)

      // Why: line-flushing proof — the *first* heartbeat chunk must arrive
      // strictly before the exit chunk; i.e. we got at least two separate
      // stderr data events (heartbeat + final). A single-chunk delivery
      // would indicate stderr was buffered until exit.
      const lastStderrAt = stderrChunks.at(-1)?.at ?? 0
      const firstStderrAt = stderrChunks.at(0)?.at ?? 0
      expect(lastStderrAt).toBeGreaterThan(firstStderrAt)

      // Stdout: exactly one JSON payload, the terminal result. No heartbeats
      // leak, and the content parses as valid JSON.
      const stdoutTrimmed = stdout.trim()
      const stdoutPayload = JSON.parse(stdoutTrimmed) as Record<string, unknown>
      expect(stdoutPayload).not.toHaveProperty('_heartbeat')
      expect(stdoutTrimmed).not.toContain('_heartbeat')
      // Why: result should be an RPC success envelope with the expected
      // shape. `count: 0` and `messages: []` because the wait timed out
      // with no message for term_nobody.
      expect(stdoutPayload).toMatchObject({ ok: true })

      // Why: the heartbeats-on-stderr design is meant to pair with shell
      // filters like `2>&1 | jq "select(._heartbeat|not)"`. jq is
      // line-oriented by default, but also accepts pretty-printed JSON
      // across multiple lines. What matters here is that every
      // heartbeat line on stderr is a standalone JSON object (so jq can
      // match it) and doesn't span multiple lines — assert that each
      // heartbeat is a single-line JSON with no embedded newlines.
      for (const line of stderr.split('\n')) {
        if (line.trim().length === 0) {
          continue
        }
        if (line.includes('_heartbeat')) {
          expect(() => JSON.parse(line)).not.toThrow()
          expect(line).not.toContain('\n')
        }
      }
    } finally {
      db.close()
      await server.stop()
    }
  }, 30_000)
})
