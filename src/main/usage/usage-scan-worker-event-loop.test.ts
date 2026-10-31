import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { Worker } from 'node:worker_threads'
import { scanCodexUsageFiles } from '../codex-usage/scanner'
import { UsageScanWorkerClient, scanCodexUsageOnWorker } from './usage-scan-worker-client'
import type { UsageScanWorktreeRef } from './usage-provider-contract'
import { readUsageSourceCache, type UsageSourceCacheRef } from './usage-source-cache-file'

// Compare calling-thread active JS milliseconds for identical inline/worker corpora, not CPU-contention-sensitive active/wall ratios (#18788). Require both arms to scan real data or an empty scan could pass.

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
  // Unique event keys per file prevent fork-copy deduplication from shrinking the measured corpus.
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

/** Set the real process environment: Worker env changes process.env but os.homedir reads the shared OS environment and would scan the developer's real history. */
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
  // Bundle the production source because Worker needs JavaScript; keep the oracle on the real scanner.
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
  it('costs the calling thread a fraction of the JS time the same scan does inline', async () => {
    // Measure inline before any worker exists; warming OS cache for the worker only understates the asserted gap.
    const caller = await measureCallerOccupancy(() => scanCodexUsageOnCallingThread())
    expect(caller.value.processedFiles).toHaveLength(FILE_COUNT)
    expect(caller.value.sessions).toHaveLength(FILE_COUNT)
    expect(caller.value.dailyAggregates).toHaveLength(1)
    expect(caller.value.dailyAggregates[0]?.eventCount).toBe(EXPECTED_EVENTS)

    const client = createWorkerClient()
    const sourceCache: UsageSourceCacheRef = {
      path: join(corpusRoot, 'orca-codex-usage-sources.json'),
      schemaVersion: 1,
      worktreeFingerprint: '[]',
      reuse: true
    }
    const worker = await measureCallerOccupancy(() =>
      withCorpusEnv(() =>
        scanCodexUsageOnWorker((body) => client.scan(body), WORKTREES, sourceCache)
      )
    )
    expect(await readUsageSourceCache(sourceCache)).toHaveLength(FILE_COUNT)
    expect(worker.value.sessions).toHaveLength(FILE_COUNT)
    expect(worker.value.dailyAggregates).toHaveLength(1)
    expect(worker.value.dailyAggregates[0]?.eventCount).toBe(EXPECTED_EVENTS)

    // Request posting/cloning still costs main time; allow one fifth of inline occupancy (measured margins 50–90x).
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
