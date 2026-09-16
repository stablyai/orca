#!/usr/bin/env node
// git show <base>:src/main/ai-vault/session-scanner.ts | node config/scripts/session-scan-cutoff-benchmark.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import ts from 'typescript-api'
import { build } from 'esbuild'
import { buildCounterbalancedSchedule } from './counterbalanced-benchmark-schedule.mjs'

const baselineSource = ts.createSourceFile(
  'session-scanner.ts',
  readFileSync(0, 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS
)
const baselineFunction = baselineSource.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'canStopParsingSessions'
)
assert(baselineFunction, 'Pipe the baseline session-scanner.ts on stdin')

async function load(contents) {
  const result = await build({
    stdin: { contents, resolveDir: path.resolve('src/main/ai-vault'), loader: 'ts' },
    platform: 'node',
    format: 'esm',
    bundle: true,
    write: false
  })
  const encoded = Buffer.from(result.outputFiles[0].text).toString('base64')
  return import(`data:text/javascript;base64,${encoded}`)
}
const [baselineModule, currentModule] = await Promise.all([
  load(`import { sessionSortTime } from './session-scanner-accumulator';
export ${baselineFunction.getText(baselineSource)}`),
  load(`export { canStopParsingSessions } from './session-scan-cutoff';
export { CodexSessionCollection } from './codex-session-root-dedup';`)
])
const baseline = baselineModule.canStopParsingSessions
const current = currentModule.canStopParsingSessions
const { CodexSessionCollection } = currentModule

let randomState = 91114
function random(bound) {
  randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0
  return Math.floor((randomState / 2 ** 32) * bound)
}
function session(index, overrides = {}) {
  return Object.freeze({
    agent: 'claude',
    executionHostId: 'local',
    sessionId: `session-${index}`,
    filePath: `/home/ada/.codex/sessions/rollout-${index}.jsonl`,
    codexHome: null,
    updatedAt: new Date(index).toISOString(),
    modifiedAt: new Date(0).toISOString(),
    ...overrides
  })
}
function collection(rows) {
  const result = new CodexSessionCollection()
  for (const row of rows) {
    result.add(row)
  }
  return result
}
function check(sessions, limit, next) {
  const rows = [...sessions.values()]
  assert.equal(current(sessions, limit, next), baseline(sessions, limit, next))
  assert.deepEqual([...sessions.values()], rows)
}

const dates = [
  null,
  '',
  'invalid',
  '1970-01-01T00:00:00Z',
  '1970-01-01T00:00:02+00:00',
  '-000001-01-01T00:00:00Z',
  '+010000-01-01T00:00:00Z',
  '-271821-04-20T00:00:00.000Z'
]
const limits = [0, -1, -3, 0.5, 1.5, Number.NaN, Infinity, -Infinity]
const nextTimes = [undefined, Number.NaN, Infinity, -Infinity, 0, 1, 2, 2000]
let comparisons = 0
for (let trial = 0; trial < 4_000; trial += 1) {
  const sessions = new CodexSessionCollection()
  const admitted = []
  for (let batch = 0; batch < 10; batch += 1) {
    const count = random(8)
    for (let index = 0; index < count; index += 1) {
      const id = random(12)
      const row =
        admitted.length && random(5) === 0
          ? admitted[random(admitted.length)]
          : session(id, {
              agent: random(3) ? 'codex' : 'claude',
              executionHostId: random(4) ? 'local' : 'ssh:dev',
              codexHome: random(2) ? null : '/custom',
              updatedAt: random(3)
                ? new Date(random(5000) - 2500).toISOString()
                : dates[random(dates.length)],
              modifiedAt: random(4) ? new Date(random(5000)).toISOString() : 'invalid'
            })
      admitted.push(row)
      sessions.add(row)
    }
    const limit = random(3) ? 1 + random(40) : limits[random(limits.length)]
    const next = random(2) ? random(5000) - 2500 : nextTimes[random(nextTimes.length)]
    check(sessions, limit, next)
    comparisons += 1
  }
}
console.log(`${comparisons} differential batch cutoffs passed.`)

function median(values) {
  const sorted = values.toSorted((left, right) => left - right)
  return (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
}
function measure(name, run, repeats) {
  const expected = run(baseline)
  assert.deepEqual(run(current), expected)
  const sample = (cutoff) => {
    let result
    const start = performance.now()
    for (let index = 0; index < repeats; index += 1) {
      result = run(cutoff)
    }
    const elapsed = (performance.now() - start) / repeats
    assert.deepEqual(result, expected)
    return elapsed
  }
  sample(baseline)
  sample(current)
  const samples = { baseline: [], current: [] }
  for (const pair of buildCounterbalancedSchedule(8, 'baseline', 'current')) {
    for (const arm of pair) {
      samples[arm].push(sample(arm === 'baseline' ? baseline : current))
    }
  }
  return { name, beforeMs: median(samples.baseline), afterMs: median(samples.current) }
}

console.log(
  JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch })
)
const results = []
for (const count of [8, 100, 1_000, 2_000, 10_000]) {
  for (const order of ['ordered', 'shuffled']) {
    const rows = Array.from({ length: count }, (_, index) => session(count - index))
    if (order === 'shuffled') {
      for (let index = count - 1; index > 0; index -= 1) {
        const other = random(index + 1)
        ;[rows[index], rows[other]] = [rows[other], rows[index]]
      }
    }
    const sessions = collection(rows)
    for (const next of [0, count]) {
      results.push(
        measure(
          `${count} ${order} / ${next === 0 ? 'stop' : 'continue'}`,
          (cutoff) => cutoff(sessions, Math.ceil(count / 2), next),
          Math.max(20, Math.floor(30_000 / count))
        )
      )
    }
  }
}
for (const invalidIndex of [0, 999]) {
  const sessions = collection(
    Array.from({ length: 1_000 }, (_, index) =>
      session(index, invalidIndex === index ? { updatedAt: 'invalid' } : {})
    )
  )
  results.push(measure(`1000 invalid at ${invalidIndex}`, (cutoff) => cutoff(sessions, 500, 0), 50))
}
const rows = Array.from({ length: 2_000 }, () => session(random(2_000)))
results.push(
  measure(
    '2000-candidate scan cutoff + admission / limit1000',
    (cutoff) => {
      const sessions = new CodexSessionCollection()
      let index = 0
      while (index < rows.length && !cutoff(sessions, 1_000, 10_000)) {
        const end = Math.min(rows.length, index + Math.min(8, Math.max(1, 1_000 - sessions.size)))
        while (index < end) {
          sessions.add(rows[index++])
        }
      }
      return { parsed: index, sessions: sessions.size }
    },
    2
  )
)
console.table(results)
console.log('Synthetic cutoff/admission CPU; excludes discovery, parsing, I/O and final sorting.')
