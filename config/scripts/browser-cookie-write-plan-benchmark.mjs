#!/usr/bin/env node
// Compare actual cookie planners; fixtures contain domains and partition metadata only.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { runProcess } from '@orca/process-host'
import { build } from 'esbuild'
import { buildCounterbalancedSchedule } from './counterbalanced-benchmark-schedule.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const paths = [
  'src/main/browser/browser-cookie-import-write.ts',
  'src/main/browser/browser-cookie-import-policy.ts'
]
const { values } = parseArgs({
  options: { baseline: { type: 'string' }, candidate: { type: 'string' } }
})
if (!values.baseline) {
  throw new Error('Pass --baseline <Git revision>')
}
if (process.env.ORCA_BACKGROUND_LAUNCH !== '1') {
  throw new Error('Run with ORCA_BACKGROUND_LAUNCH=1')
}

async function readSources(revision) {
  const entries = await Promise.all(
    paths.map(async (path) => {
      if (!revision) {
        return [join(root, path), readFileSync(join(root, path), 'utf8')]
      }
      const result = await runProcess({
        program: 'git',
        args: ['show', `${revision}:${path}`],
        cwd: root,
        maxOutputBytes: 1024 * 1024,
        timeoutMs: 10_000
      })
      assert.equal(result.code, 0, result.stderr)
      assert.equal(result.outputTruncated, false)
      return [join(root, path), result.stdout]
    })
  )
  return new Map(entries)
}

async function loadPlanner(sources) {
  const result = await build({
    entryPoints: [join(root, paths[0])],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    plugins: [
      {
        name: 'revision-cookie-planner',
        setup(builder) {
          builder.onLoad({ filter: /browser-cookie-import-(write|policy)\.ts$/ }, (args) => ({
            contents: sources.get(args.path),
            loader: 'ts',
            resolveDir: dirname(args.path)
          }))
        }
      }
    ]
  })
  const encoded = Buffer.from(result.outputFiles[0].text).toString('base64')
  return (await import(`data:text/javascript;base64,${encoded}`)).planImportWrites
}

const sources = await Promise.all([readSources(values.baseline), readSources(values.candidate)])
const [before, after] = await Promise.all(sources.map(loadPlanner))
const readable = { status: 'unpartitioned' }
const unreadable = { status: 'unreadable', reason: 'fixture missing partition metadata' }
const row = (domain, partition = readable) => ({ domain, partition })

const controls = [
  [row('.mixed.example'), row('sub.mixed.example', unreadable), row('.other.example')],
  [row('sub.mixed.example', unreadable), row('.mixed.example')],
  [row('com', unreadable), row('.good.example')],
  [row('foo.github.io', unreadable), row('bar.github.io'), row('sub.foo.github.io')],
  [row('127.1', unreadable), row('127.0.0.1'), row('[::1]')],
  [row('invalid/domain'), row('com'), row('LOCALHOST')],
  []
]
for (const rows of controls) {
  assert.deepEqual(after(rows), before(rows))
}

function domainReads(planner) {
  let reads = 0
  const rows = Array.from({ length: 2000 }, () => ({
    get domain() {
      reads += 1
      return '.good.example'
    },
    partition: readable
  }))
  const result = planner(rows)
  assert.equal(result.writes.length, rows.length)
  assert(result.writes.every((cookie, index) => cookie === rows[index]))
  return reads
}

const reads = { before: domainReads(before), after: domainReads(after) }
assert.equal(reads.before, 2000, 'Baseline must exercise the original family scan')
assert.equal(reads.after, 0, 'Candidate still scans unused readable domains')

function median(samples) {
  const sorted = samples.toSorted((left, right) => left - right)
  const midpoint = sorted.length / 2
  return (sorted[midpoint - 1] + sorted[midpoint]) / 2
}

function measure(rows, iterations) {
  assert.deepEqual(after(rows), before(rows))
  const planners = { before, after }
  const samples = { before: [], after: [] }
  for (const planner of Object.values(planners)) {
    for (let warmup = 0; warmup < 5; warmup += 1) {
      planner(rows)
    }
  }
  for (const order of buildCounterbalancedSchedule(6, 'before', 'after')) {
    for (const arm of order) {
      const start = performance.now()
      let writes = 0
      for (let iteration = 0; iteration < iterations; iteration += 1) {
        writes += planners[arm](rows).writes.length
      }
      samples[arm].push((performance.now() - start) / iterations)
      assert(writes <= rows.length * iterations)
    }
  }
  return { beforeMs: median(samples.before), afterMs: median(samples.after) }
}

const measurements = []
for (const [count, iterations] of [
  [100, 500],
  [1000, 100],
  [10000, 20],
  [50000, 8],
  [150000, 4]
]) {
  const rows = Array.from({ length: count }, (_, index) =>
    row(`.sub${index % 8}.site${index % 1200}.com`)
  )
  measurements.push({ cookies: count, mode: 'all readable', ...measure(rows, iterations) })
}
const mixed = Array.from({ length: 10000 }, (_, index) => row(`.site${index % 1200}.com`))
mixed.push(row('sub.site1.com', unreadable))
measurements.push({
  cookies: mixed.length,
  mode: 'unreadable-family control',
  ...measure(mixed, 20)
})

console.log(
  JSON.stringify(
    {
      baseline: values.baseline,
      candidate: values.candidate ?? 'working tree',
      sourceHashes: sources.map((source) =>
        Object.fromEntries(
          paths.map((path) => [
            path,
            createHash('sha256')
              .update(source.get(join(root, path)))
              .digest('hex')
          ])
        )
      ),
      node: process.version,
      platform: process.platform,
      domainReads: reads,
      controlCases: controls.length,
      measurements,
      limitation: 'Planner CPU only. Large synthetic jars; no whole-import or UI latency claim.'
    },
    null,
    2
  )
)
