import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { Worker } from 'node:worker_threads'
import { scanCodexUsageFiles } from '../codex-usage/scanner'
import {
  UsageScanWorkerClient,
  scanClaudeUsageOnWorker,
  scanCodexUsageOnWorker
} from './usage-scan-worker-client'
import type { UsageScanWorktreeRef } from './usage-provider-contract'

// Why this test exists: "the scan no longer blocks the main process" is not a
// stopwatch claim. It measures the *calling* thread's event-loop active time —
// the milliseconds that thread spent running JS rather than parked in the
// loop's poll phase.
//
// One case runs both arms over one corpus so they are compared against each
// other rather than each against a fixed threshold: the identical scan goes
// first through the pre-worker calling-thread path, then through the worker,
// and the worker arm must cost the caller a fraction of the JS time.
//
// Active milliseconds, not the active/wall fraction (issue #18788): CPU
// contention drags the calling-thread arm's *fraction* down toward the
// worker's — a loaded ubuntu runner measured 0.76 against a 0.8 floor — while
// stretching wall time, which widens the millisecond gap instead.
//
// The presence preconditions on both arms are load-bearing. An arm that
// silently scanned nothing would otherwise satisfy the comparison trivially.

const FILE_COUNT = 600
const EVENTS_PER_FILE = 60
const EXPECTED_EVENTS = FILE_COUNT * EVENTS_PER_FILE
const TOKENS_PER_EVENT = 200

const WORKTREES: UsageScanWorktreeRef[] = [
  {
    repoId: 'repo-1',
    worktreeId: 'wt-1',
    path: '/tmp/orca-usage-oracle-project',
    displayName: 'demo'
  }
]

let corpusRoot = ''
let workerEntryPath = ''

function buildRolloutLines(sessionId: string, seed: number): string {
  const lines: string[] = [
    JSON.stringify({
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'session_meta',
      payload: { id: sessionId, cwd: '/tmp/orca-usage-oracle-project' }
    }),
    JSON.stringify({
      timestamp: '2026-01-01T00:00:01.000Z',
      type: 'turn_context',
      payload: { cwd: '/tmp/orca-usage-oracle-project', model: 'gpt-5.6-sol' }
    })
  ]
  // Seeded per file so no two rollouts mint the same event key; identical keys
  // would be deduped as fork copies and shrink the corpus the scan actually parses.
  let total = seed * 10_000_000
  for (let index = 0; index < EVENTS_PER_FILE; index++) {
    total += TOKENS_PER_EVENT
    lines.push(
      JSON.stringify({
        timestamp: new Date(Date.UTC(2026, 0, 1, 1, 0, index % 60)).toISOString(),
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: total,
              cached_input_tokens: 0,
              output_tokens: 0,
              reasoning_output_tokens: 0,
              total_tokens: total
            },
            last_token_usage: {
              input_tokens: TOKENS_PER_EVENT,
              cached_input_tokens: 0,
              output_tokens: 0,
              reasoning_output_tokens: 0,
              total_tokens: TOKENS_PER_EVENT
            }
          },
          // Padding so each line is rollout-shaped rather than trivially short.
          text: 'x'.repeat(200)
        }
      })
    )
  }
  return `${lines.join('\n')}\n`
}

function writeCorpus(root: string): void {
  const sessionsDir = join(root, 'codex-runtime-home', 'home', 'sessions', '2026', '01', '01')
  mkdirSync(sessionsDir, { recursive: true })
  for (let index = 0; index < FILE_COUNT; index++) {
    writeFileSync(
      join(sessionsDir, `rollout-${String(index).padStart(6, '0')}.jsonl`),
      buildRolloutLines(`session-${index}`, index + 1)
    )
  }
}

type Occupancy = {
  /** Milliseconds the calling thread spent running JS during the span. */
  activeMs: number
  /** Same span as a fraction of wall time; reported, not asserted on. */
  activeRatio: number
  wallMs: number
}

async function measureCallerOccupancy<T>(
  run: () => Promise<T>
): Promise<{ value: T; occupancy: Occupancy }> {
  const before = performance.eventLoopUtilization()
  const startedAt = performance.now()
  const value = await run()
  const wallMs = performance.now() - startedAt
  const delta = performance.eventLoopUtilization(before)
  return {
    value,
    occupancy: { activeMs: delta.active, activeRatio: delta.active / wallMs, wallMs }
  }
}

function formatOccupancy(label: string, occupancy: Occupancy): string {
  return `${label}: active ${occupancy.activeMs.toFixed(1)}ms of ${occupancy.wallMs.toFixed(1)}ms wall (ratio ${occupancy.activeRatio.toFixed(3)})`
}

function createWorkerClient(): UsageScanWorkerClient {
  return new UsageScanWorkerClient({
    workerFactory: () => new Worker(workerEntryPath),
    log: () => {}
  })
}

/**
 * Run `fn` with both Codex session lanes pointed at the fixture.
 * Why the real process environment and not the Worker `env` option: that option
 * only replaces the worker's JS-visible `process.env`, while `os.homedir()`
 * reads the OS environment the threads share — so a worker given `HOME` there
 * still scanned the developer's real ~/.codex.
 */
async function withCorpusEnv<T>(fn: () => Promise<T>): Promise<T> {
  const previous = {
    ORCA_USER_DATA_PATH: process.env.ORCA_USER_DATA_PATH,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE
  }
  process.env.ORCA_USER_DATA_PATH = corpusRoot
  process.env.HOME = corpusRoot
  process.env.USERPROFILE = corpusRoot
  try {
    return await fn()
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      restoreEnv(name, value)
    }
  }
}

beforeAll(async () => {
  corpusRoot = mkdtempSync(join(tmpdir(), 'orca-usage-scan-oracle-'))
  writeCorpus(corpusRoot)
  workerEntryPath = join(corpusRoot, 'usage-scan-worker-entry.cjs')
  // Why bundle here: `new Worker` needs JavaScript, and the production entry is
  // emitted by the app build. Bundling the same source keeps the oracle running
  // the real scanner instead of a stand-in.
  await build({
    entryPoints: [resolve(__dirname, 'usage-scan-worker-entry.ts')],
    outfile: workerEntryPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron']
  })
}, 120_000)

afterAll(() => {
  rmSync(corpusRoot, { recursive: true, force: true })
})

describe('usage scan worker event-loop occupancy', () => {
  it('scans only the selected Claude config directory through the real worker', async () => {
    const configDir = join(corpusRoot, 'selected-claude')
    const projectsDir = join(configDir, 'projects', 'repo')
    mkdirSync(projectsDir, { recursive: true })
    const transcriptPath = join(projectsDir, 'selected.jsonl')
    writeFileSync(
      transcriptPath,
      JSON.stringify({
        type: 'assistant',
        sessionId: 'selected-session',
        timestamp: '2026-04-09T10:00:00.000Z',
        cwd: WORKTREES[0].path,
        message: {
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 100, output_tokens: 20 }
        }
      })
    )
    const client = createWorkerClient()
    const result = await withCorpusEnv(() =>
      scanClaudeUsageOnWorker((body) => client.scan(body), WORKTREES, [], {
        configDir,
        includeWslHomes: false
      })
    )
    expect(result.source.map((file) => file.path)).toEqual([transcriptPath])
    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0].sessionId).toBe('selected-session')
  })

  it('costs the calling thread a fraction of the JS time the same scan does inline', async () => {
    // Calling thread first: the baseline is measured with no worker alive, and
    // the worker arm then reads an OS cache the inline arm already warmed,
    // which can only understate the gap being asserted.
    const caller = await measureCallerOccupancy(() => scanCodexUsageOnCallingThread())
    expect(caller.value.processedFiles).toHaveLength(FILE_COUNT)
    expect(caller.value.sessions).toHaveLength(FILE_COUNT)
    expect(caller.value.dailyAggregates).toHaveLength(1)
    expect(caller.value.dailyAggregates[0]?.eventCount).toBe(EXPECTED_EVENTS)

    const client = createWorkerClient()
    const worker = await measureCallerOccupancy(() =>
      withCorpusEnv(() => scanCodexUsageOnWorker((body) => client.scan(body), WORKTREES, []))
    )
    expect(worker.value.source).toHaveLength(FILE_COUNT)
    expect(worker.value.sessions).toHaveLength(FILE_COUNT)
    expect(worker.value.dailyAggregates).toHaveLength(1)
    expect(worker.value.dailyAggregates[0]?.eventCount).toBe(EXPECTED_EVENTS)

    // The caller still pays to post the request and structured-clone a
    // 600-file result back, so this is a fifth, not a rout. Measured margin is
    // ~50x idle and ~90x under CPU contention.
    expect(
      worker.occupancy.activeMs,
      `${formatOccupancy('worker', worker.occupancy)}; ${formatOccupancy('calling thread', caller.occupancy)}`
    ).toBeLessThan(caller.occupancy.activeMs / 5)
  }, 120_000)
})

function scanCodexUsageOnCallingThread(): ReturnType<typeof scanCodexUsageFiles> {
  return withCorpusEnv(() => scanCodexUsageFiles(WORKTREES, []))
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name]
    return
  }
  process.env[name] = value
}
