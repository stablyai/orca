#!/usr/bin/env node
// Compare real CLI emits before/after deferring RuntimeClient’s Zod/ws/tweetnacl/store graph until after flag validation.
// Restore seven baseline files; use fresh processes to measure cold graphs, alternate arm order, and verify output/exit equality before timing.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('../..', import.meta.url))

const ROUNDS = Number(process.env.ORCA_CLI_DEFER_BENCH_ROUNDS ?? '30')
const WARMUP = Number(process.env.ORCA_CLI_DEFER_BENCH_WARMUP ?? '3')

for (const [name, value] of [
  ['ORCA_CLI_DEFER_BENCH_ROUNDS', ROUNDS],
  ['ORCA_CLI_DEFER_BENCH_WARMUP', WARMUP]
]) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, received ${value}`)
  }
}
if (ROUNDS % 2 !== 0) {
  // Why: arms alternate which one leads; an odd count biases one arm.
  throw new Error(`ORCA_CLI_DEFER_BENCH_ROUNDS must be even, received ${ROUNDS}`)
}

const TOUCHED = [
  'src/cli/args.ts',
  'src/cli/dispatch.ts',
  'src/cli/flags.ts',
  'src/cli/format.ts',
  'src/cli/index.ts',
  'src/cli/runtime/client.ts',
  'src/cli/selectors.ts'
]

// Re-read production call forms so reverting deferral cannot make both arms identical; prose mentions must not satisfy the guard.
function assertMarkersFresh() {
  const checks = [
    ['src/cli/index.ts', "await import('./runtime-client.js')"],
    ['src/cli/index.ts', 'await loadRuntimeClientClass()'],
    ['src/cli/index.ts', "import type { RuntimeClient } from './runtime-client'"],
    ['src/cli/runtime/client.ts', "await import('./websocket-transport.js')"],
    ['src/cli/runtime/client.ts', 'await loadSendWebSocketRequest()'],
    ['src/cli/args.ts', "import { RuntimeClientError } from './runtime/types'"],
    ['src/cli/flags.ts', "import { RuntimeClientError } from './runtime/types'"],
    ['src/cli/dispatch.ts', "import { RuntimeClientError } from './runtime/types'"],
    ['src/cli/selectors.ts', "import { RuntimeClientError } from './runtime/types'"],
    ['src/cli/format.ts', "} from './runtime/types'"]
  ]
  for (const [file, marker] of checks) {
    if (!readFileSync(join(REPO, file), 'utf8').includes(marker)) {
      throw new Error(
        `${file} no longer contains \`${marker}\` — cli-runtime-client-deferral-benchmark.mjs is stale`
      )
    }
  }
}

function buildArm(label, baselineRev) {
  // Build inside repo so emitted modules resolve its node_modules.
  const outDir = join(REPO, `.bench-out-${label}`)
  rmSync(outDir, { recursive: true, force: true })
  const restore = []
  try {
    if (baselineRev) {
      for (const file of TOUCHED) {
        const path = join(REPO, file)
        restore.push([path, readFileSync(path)])
        writeFileSync(
          path,
          execFileSync('git', ['show', `${baselineRev}:${file}`], {
            cwd: REPO,
            maxBuffer: 64 * 1024 * 1024
          })
        )
      }
    }
    execFileSync(
      'npx',
      [
        'tsc',
        '-p',
        'config/tsconfig.cli.json',
        '--outDir',
        outDir,
        '--composite',
        'false',
        '--incremental',
        'false'
      ],
      { cwd: REPO, stdio: 'inherit' }
    )
  } finally {
    for (const [path, contents] of restore) {
      writeFileSync(path, contents)
    }
  }
  return join(outDir, 'cli/index.js')
}

function run(entry, argv, env) {
  const result = spawnSync(process.execPath, [entry, ...argv], {
    cwd: REPO,
    env: { ...process.env, ...env },
    encoding: 'buffer'
  })
  if (result.error) {
    throw result.error
  }
  return {
    status: result.status,
    stdout: result.stdout.toString('utf8'),
    stderr: result.stderr.toString('utf8')
  }
}

// Count eager CJS graph in a child via Module._load, measuring the graph deferral actually moves.
function countEagerModules(entry) {
  const probe = `
    const Module = require('module')
    const original = Module._load
    const seen = new Set()
    Module._load = function (request, parent, isMain) {
      try { seen.add(Module._resolveFilename(request, parent, isMain)) } catch { seen.add(request) }
      return original.apply(this, arguments)
    }
    require(${JSON.stringify(entry)})
    const all = [...seen]
    process.stdout.write(JSON.stringify({
      total: all.length,
      nodeModules: all.filter((p) => p.includes('node_modules')).length
    }))
  `
  const result = spawnSync(process.execPath, ['-e', probe], { cwd: REPO, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`module probe failed: ${result.stderr}`)
  }
  return JSON.parse(result.stdout)
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

const baselineIndex = process.argv.indexOf('--baseline')
const baselineRev = baselineIndex === -1 ? 'HEAD' : process.argv[baselineIndex + 1]

assertMarkersFresh()

const userDataPath = mkdtempSync(join(REPO, '.bench-userdata-'))

try {
  console.log(`Building eager baseline (${baselineRev}) …`)
  const eagerEntry = buildArm('eager', baselineRev)
  console.log('Building deferred (working tree) …')
  const deferredEntry = buildArm('deferred', null)

  const eagerGraph = countEagerModules(eagerEntry)
  const deferredGraph = countEagerModules(deferredEntry)
  console.log(
    `\nEager modules at process load: ${eagerGraph.total} -> ${deferredGraph.total} ` +
      `(node_modules ${eagerGraph.nodeModules} -> ${deferredGraph.nodeModules})`
  )
  if (deferredGraph.total >= eagerGraph.total) {
    throw new Error(
      'deferred arm loads no fewer modules — the fixture does not exercise the change'
    )
  }

  // Use empty user-data dirs for deterministic runtime-dependent cases.
  const isolated = { ORCA_USER_DATA_PATH: userDataPath }
  /** @type {Array<[string, string[], Record<string, string>]>} */
  const cases = [
    ['orca --help', ['--help'], {}],
    ['orca help worktree', ['help', 'worktree'], {}],
    ['orca (no args)', [], {}],
    ['unknown command', ['no-such-command'], {}],
    ['unknown flag', ['worktree', 'list', '--nope'], {}],
    ['orca agent-context --json', ['agent-context', '--json'], {}],
    ['orca status --json', ['status', '--json'], isolated],
    ['orca worktree list --json', ['worktree', 'list', '--json'], isolated]
  ]

  // Compare output/exit before timing or a broken arm printing nothing appears fastest.
  for (const [label, argv, env] of cases) {
    const before = run(eagerEntry, argv, env)
    const after = run(deferredEntry, argv, env)
    if (
      before.status !== after.status ||
      before.stdout !== after.stdout ||
      before.stderr !== after.stderr
    ) {
      throw new Error(`arms disagree for "${label}" — refusing to report a timing`)
    }
    if (before.stdout.length + before.stderr.length === 0) {
      throw new Error(`"${label}" produced no output on either arm; it proves nothing`)
    }
  }

  const pad = (value, width) => String(value).padStart(width)
  console.log('\nFresh process per sample, wall clock. Lower is better.')
  console.log(`rounds=${ROUNDS} warmup=${WARMUP} (per-arm median, arms alternate lead)`)
  console.log(`${pad('case', 26)} ${pad('eager', 10)} ${pad('deferred', 10)} ${pad('speedup', 9)}`)

  // Accumulated so V8 cannot treat the spawn loop as dead code.
  let consumed = 0

  for (const [label, argv, env] of cases) {
    for (let index = 0; index < WARMUP; index += 1) {
      consumed += run(eagerEntry, argv, env).stdout.length
      consumed += run(deferredEntry, argv, env).stdout.length
    }
    const samples = { eager: [], deferred: [] }
    for (let round = 0; round < ROUNDS; round += 1) {
      // Alternate which arm leads so a drifting machine load cannot be
      // attributed to one arm.
      const order =
        round % 2 === 0
          ? [
              ['eager', eagerEntry],
              ['deferred', deferredEntry]
            ]
          : [
              ['deferred', deferredEntry],
              ['eager', eagerEntry]
            ]
      for (const [arm, entry] of order) {
        const started = performance.now()
        const result = run(entry, argv, env)
        samples[arm].push(performance.now() - started)
        consumed += result.stdout.length
      }
    }
    const eagerMs = median(samples.eager)
    const deferredMs = median(samples.deferred)
    console.log(
      `${pad(label, 26)} ${pad(`${eagerMs.toFixed(1)} ms`, 10)} ${pad(`${deferredMs.toFixed(1)} ms`, 10)} ${pad(`${(eagerMs / deferredMs).toFixed(2)}x`, 9)}`
    )
  }

  if (consumed === 0) {
    throw new Error('no output consumed — the timing loop was optimised away')
  }
  console.log(
    '\nThe help and error rows are the ones the change targets: they return\n' +
      'before any client construction, so they drop the whole graph. `status` and\n' +
      '`worktree list` still construct a client, so they only save the eager parse\n' +
      'of the parts the local path never uses (ws/tweetnacl via websocket-transport).'
  )
} finally {
  rmSync(userDataPath, { recursive: true, force: true })
  for (const label of ['eager', 'deferred']) {
    rmSync(join(REPO, `.bench-out-${label}`), { recursive: true, force: true })
  }
}
