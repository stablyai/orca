#!/usr/bin/env node
// Run: node config/scripts/legacy-worker-recovery-persistence-benchmark.mjs
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, open, readFile, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const runtimePath = join(repoRoot, 'src/main/runtime/orca-runtime.ts')
const args = new Map(
  process.argv.slice(2).map((value, index, values) => [value, values[index + 1]])
)
const fixtureMiB = Number(args.get('--fixture-mib') ?? 24)
const trials = Number(args.get('--trials') ?? 3)
const jsonOutput = process.argv.includes('--json')

if (!Number.isInteger(fixtureMiB) || fixtureMiB < 1 || !Number.isInteger(trials) || trials < 1) {
  throw new Error('fixture-mib and trials must be positive integers')
}

const runtimeSource = await readFile(runtimePath, 'utf8')
const recoveryStart = runtimeSource.indexOf(
  'private async persistLegacyWorkerTerminalRecoveryBatch'
)
const recoveryEnd = runtimeSource.indexOf(
  'private reconcileMissingLegacyWorkerTerminal',
  recoveryStart
)
const recoverySource = runtimeSource.slice(recoveryStart, recoveryEnd)
if (
  recoveryStart === -1 ||
  recoveryEnd === -1 ||
  !recoverySource.includes('await this.flushWorkspaceSessionOrThrowAsync()') ||
  recoverySource.includes('flushOrThrow()')
) {
  throw new Error('recovery persistence implementation changed; update this benchmark')
}

const root = await mkdtemp(join(tmpdir(), 'orca-legacy-recovery-benchmark-'))
const filler = 'x'.repeat(fixtureMiB * 1024 * 1024)

function payload(state) {
  return JSON.stringify({ state, filler })
}

function writeDurableSync(path, body) {
  const tempPath = `${path}.sync.tmp`
  writeFileSync(tempPath, body)
  const fd = openSync(tempPath, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tempPath, path)
}

async function writeDurableAsync(path, body) {
  const tempPath = `${path}.async.tmp`
  const handle = await open(tempPath, 'w')
  try {
    await handle.writeFile(body)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(tempPath, path)
}

async function measure(run) {
  let maxEventLoopDelayMs = 0
  let expected = performance.now() + 1
  const timer = setInterval(() => {
    const now = performance.now()
    maxEventLoopDelayMs = Math.max(maxEventLoopDelayMs, now - expected)
    expected = now + 1
  }, 1)
  await new Promise((resolve) => setTimeout(resolve, 5))
  const startedAt = performance.now()
  await run()
  const durationMs = performance.now() - startedAt
  await new Promise((resolve) => setTimeout(resolve, 5))
  clearInterval(timer)
  return { durationMs, maxEventLoopDelayMs }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

async function runLegacy(path) {
  const state = { fenced: false, surfacePresent: true, recoveryRecordPresent: true }
  state.fenced = true
  writeDurableSync(path, payload(state))
  state.surfacePresent = false
  writeDurableSync(path, payload(state))
  state.recoveryRecordPresent = false
  writeDurableSync(path, payload(state))
}

async function runBatched(path) {
  const state = { fenced: false, surfacePresent: true, recoveryRecordPresent: true }
  state.fenced = true
  state.surfacePresent = false
  state.recoveryRecordPresent = false
  await writeDurableAsync(path, payload(state))
}

try {
  const legacy = []
  const batched = []
  for (let index = 0; index < trials; index += 1) {
    legacy.push(await measure(() => runLegacy(join(root, `legacy-${index}.json`))))
    batched.push(await measure(() => runBatched(join(root, `batched-${index}.json`))))
  }
  const result = {
    benchmark: 'legacy-worker-recovery-persistence',
    fixtureMiB,
    trials,
    legacy: {
      durableWrites: 3,
      medianDurationMs: median(legacy.map((sample) => sample.durationMs)),
      medianMaxEventLoopDelayMs: median(legacy.map((sample) => sample.maxEventLoopDelayMs))
    },
    batchedAsync: {
      durableWrites: 1,
      medianDurationMs: median(batched.map((sample) => sample.durationMs)),
      medianMaxEventLoopDelayMs: median(batched.map((sample) => sample.maxEventLoopDelayMs))
    }
  }
  if (jsonOutput) {
    console.log(JSON.stringify(result))
  } else {
    console.log(JSON.stringify(result, null, 2))
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}
