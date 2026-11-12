import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { build } from 'esbuild'
import { buildCounterbalancedSchedule } from '../measurement/counterbalanced-benchmark-schedule.mjs'
import { summarizeBenchmarkSamples } from '../measurement/benchmark-sample-summary.mjs'
import ts from 'typescript-api'

const baselineSourcePathArgument = process.argv.find((arg) =>
  arg.startsWith('--baseline-source-path=')
)
const baselineSourcePath = resolve(
  baselineSourcePathArgument?.slice('--baseline-source-path='.length) ??
    'src/main/ai-vault/session-scanner-accumulator.ts'
)

function retargetLegacyAccumulatorValueImports(source) {
  const program = ts.createSourceFile(baselineSourcePath, source, ts.ScriptTarget.Latest, true)
  assert.equal(program.parseDiagnostics.length, 0, 'Baseline source must parse')
  const replacements = []
  for (const statement of program.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue
    }
    if (
      resolve(dirname(baselineSourcePath), statement.moduleSpecifier.text) !==
      resolve('src/main/ai-vault/session-scanner-values')
    ) {
      continue
    }
    const clause = statement.importClause
    assert(
      clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings)
    )
    const imports = clause.namedBindings.elements.map((binding) => {
      const name = (binding.propertyName ?? binding.name).text
      const owner =
        name === 'extractString'
          ? 'src/shared/trimmed-string.ts'
          : name === 'timestampMs'
            ? 'src/main/ai-vault/parsing/session-record-time.ts'
            : null
      assert(owner, `Unsupported historical accumulator value import: ${name}`)
      return `import ${clause.isTypeOnly ? 'type ' : ''}{ ${binding.getText(program)} } from ${JSON.stringify(resolve(owner))}`
    })
    replacements.push({
      start: statement.getStart(program),
      end: statement.end,
      text: imports.join('\n')
    })
  }
  for (const replacement of replacements.toReversed()) {
    source = source.slice(0, replacement.start) + replacement.text + source.slice(replacement.end)
  }
  return source
}

// git show <ref>:src/main/ai-vault/session-scanner-accumulator.ts | node config/scripts/session-timeline-benchmark.mjs
const target = resolve('src/main/ai-vault/parsing/session-scanner-accumulator.ts')
async function load(source, sourcePath = target) {
  const result = await build({
    stdin: {
      contents: `
        export {createAccumulator, cloneSessionAccumulator, updateTimeline, finalizeSession}
          from './session-scanner-accumulator';
        export {createClaudeSessionParseState, consumeClaudeSessionLine}
          from '../scanners/claude/session-scanner-primary-parsers';`,
      loader: 'ts',
      resolveDir: dirname(target)
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    plugins: [
      {
        name: 'timeline-baseline',
        setup(plugin) {
          plugin.onLoad({ filter: /session-scanner-accumulator\.ts$/ }, () => ({
            contents: source,
            loader: 'ts',
            resolveDir: dirname(sourcePath)
          }))
        }
      }
    ]
  })
  const directory = await mkdtemp(join(tmpdir(), 'orca-session-timeline-'))
  try {
    const file = join(directory, 'timeline.cjs')
    await writeFile(file, result.outputFiles[0].text)
    return createRequire(import.meta.url)(file)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
const implementations = {
  before: await load(
    retargetLegacyAccumulatorValueImports(readFileSync(0, 'utf8')),
    baselineSourcePath
  ),
  after: await load(readFileSync(target, 'utf8'))
}
const file = { path: 'timeline.jsonl', mtimeMs: 0, modifiedAt: '2026-01-01T00:00:00.000Z' }
const create = (implementation) =>
  implementation.createAccumulator({ agent: 'claude', sessionId: 'timeline', file })
const observable = ({ createdAt, updatedAt, latestTimestampMs }) => ({
  createdAt,
  updatedAt,
  latestTimestampMs
})

let seed = 42
const random = (max) => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  return Math.floor((seed / 2 ** 32) * max)
}
const tokens = [
  null,
  undefined,
  '',
  'bad',
  0,
  -1,
  Infinity,
  Number.NaN,
  8_640_000_000_000_001,
  '1969-12-31T23:59:59.999Z',
  '-000001-01-01T00:00:00.000Z',
  '+010000-01-01T00:00:00.000Z',
  '2026-01-01T01:00:00+01:00',
  1_700_000_000.0009,
  1_700_000_000_000.9,
  1_700_000_000_000.1,
  1_700_000_000_000 - 0.1
]
let differentialUpdates = 0
for (let trial = 0; trial < 3000; trial += 1) {
  let before = create(implementations.before)
  let after = create(implementations.after)
  for (let index = 0; index < 32; index += 1) {
    const input = random(2) ? tokens[random(tokens.length)] : 1_700_000_000_000 + random(1000) / 10
    const update = (implementation, state) => {
      try {
        implementation.updateTimeline(state, input)
      } catch (error) {
        return String(error)
      }
      return null
    }
    assert.equal(update(implementations.after, after), update(implementations.before, before))
    assert.deepEqual(observable(after), observable(before))
    if (index === 15) {
      before = implementations.before.cloneSessionAccumulator(before)
      after = implementations.after.cloneSessionAccumulator(after)
    }
    differentialUpdates += 1
  }
  assert.deepEqual(
    implementations.after.finalizeSession(after, 'linux'),
    implementations.before.finalizeSession(before, 'linux')
  )
}

const results = []
for (const records of [100, 10_000, 100_000]) {
  for (const workload of [
    'numeric-timeline',
    'iso-timeline',
    'out-of-order-timeline',
    'claude-record-fold'
  ]) {
    const timestamps = Array.from({ length: records }, (_, index) => {
      const ms =
        1_700_000_000_000 + (workload === 'out-of-order-timeline' ? random(records) : index)
      return workload === 'numeric-timeline' ? ms : new Date(ms).toISOString()
    })
    const lines =
      workload === 'claude-record-fold'
        ? timestamps.map((timestamp, index) =>
            JSON.stringify({
              type: index % 2 ? 'assistant' : 'user',
              sessionId: 'timeline',
              timestamp,
              message: {
                role: index % 2 ? 'assistant' : 'user',
                content: 'Example transcript message'
              }
            })
          )
        : []
    function run(arm) {
      const implementation = implementations[arm]
      const parser = implementation.createClaudeSessionParseState(file)
      const state = workload === 'claude-record-fold' ? parser.accumulator : create(implementation)
      const started = performance.now()
      if (workload === 'claude-record-fold') {
        for (const line of lines) {
          implementation.consumeClaudeSessionLine(parser, line)
        }
      } else {
        for (const timestamp of timestamps) {
          implementation.updateTimeline(state, timestamp)
        }
      }
      const ms = performance.now() - started
      return {
        ms,
        result: implementation.finalizeSession(state, 'linux'),
        timeline: observable(state)
      }
    }
    const expected = run('before')
    assert.deepEqual(run('after').result, expected.result)
    /** @type {{ before: number[], after: number[] }} */
    const samples = { before: [], after: [] }
    for (const pair of buildCounterbalancedSchedule(8, 'before', 'after')) {
      for (const arm of pair) {
        const actual = run(arm)
        samples[arm].push(actual.ms)
        assert.deepEqual(actual.result, expected.result)
        assert.deepEqual(actual.timeline, expected.timeline)
      }
    }
    results.push({
      records,
      workload,
      before: summarizeBenchmarkSamples(samples.before),
      after: summarizeBenchmarkSamples(samples.after)
    })
  }
}
console.log(
  JSON.stringify(
    { node: process.version, platform: process.platform, differentialUpdates, results },
    null,
    2
  )
)
