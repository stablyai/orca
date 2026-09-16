import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { transform } from 'esbuild'
import { buildCounterbalancedSchedule } from './counterbalanced-benchmark-schedule.mjs'
import { summarizeBenchmarkSamples } from './benchmark-sample-summary.mjs'

const baseline = process.argv[2]
if (!baseline) {
  throw new Error(
    'Usage: node config/scripts/mobile-file-ranking-benchmark.mjs <baseline-ref|--autocomplete-stdin>'
  )
}
// git show <ref>:mobile/src/session/mobile-native-chat-autocomplete.ts | node config/scripts/mobile-file-ranking-benchmark.mjs --autocomplete-stdin
const autocompleteSource = baseline === '--autocomplete-stdin' ? readFileSync(0, 'utf8') : null
async function load(source) {
  const { code } = await transform(source, { loader: 'ts', format: 'esm' })
  return await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
}
const results = []
let differentialCases = 0
for (const [file, name] of [
  ['src/main/runtime/runtime-mobile-file-path-search.ts', 'rankRuntimeMobileFilePaths'],
  ['mobile/src/session/mobile-native-chat-autocomplete.ts', 'rankSuggestions'],
  ['mobile/src/session/mobile-native-chat-autocomplete.ts', 'rankSlashCommandSuggestions']
]) {
  if (autocompleteSource !== null && name === 'rankRuntimeMobileFilePaths') {
    continue
  }
  const before = (
    await load(
      autocompleteSource ??
        execFileSync('git', ['show', `${baseline}:${file}`], { encoding: 'utf8' })
    )
  )[name]
  const after = (await load(readFileSync(file, 'utf8')))[name]
  const slash = name === 'rankSlashCommandSuggestions'
  const toCandidates = (names) =>
    slash ? names.map((name, index) => ({ name, description: `Command ${index}` })) : names
  if (name !== 'rankRuntimeMobileFilePaths') {
    let seed = 42
    const random = (max) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed % max
    }
    const tokens = ['', 'app', 'src/', 'APP', 'zapp', '🙂', '한', '\ud800', '\u0130', ' ']
    const limits = [
      undefined,
      0,
      -0,
      -1,
      -0.5,
      -Infinity,
      Number.NaN,
      0.5,
      1.5,
      2.5,
      8,
      16,
      Infinity
    ]
    for (let index = 0; index < 3000; index += 1) {
      const candidates = toCandidates(
        Array.from(
          { length: random(100) },
          () => tokens[random(tokens.length)] + tokens[random(tokens.length)]
        )
      )
      const query = tokens[random(tokens.length)]
      const limit = limits[random(limits.length)]
      assert.deepEqual(after(candidates, query, limit), before(candidates, query, limit))
      differentialCases += 1
    }
  }
  for (const count of slash ? [16, 100, 1000] : [16, 100, 10_000, 50_000, 100_000]) {
    const names = Array.from({ length: count }, (_, index) =>
      slash
        ? `team-review-${index}`
        : `src/components/workspace/group-${index % 100}/file-${index}.tsx`
    )
    const limit = slash ? 12 : 16
    const substringQuery = slash ? 'review' : 'workspace'
    const workloads = [
      { name: 'empty-query', names, query: '' },
      { name: 'substring', names, query: substringQuery },
      { name: 'no-match', names, query: 'missing' },
      { name: 'early-prefix', names, query: slash ? 'team' : 'file' },
      {
        name: 'late-prefix',
        names: [...names, ...Array.from({ length: 4 }, (_, index) => `${substringQuery}-${index}`)],
        query: substringQuery
      }
    ]
    for (const workload of workloads) {
      const candidates = toCandidates(workload.names)
      const expected = before(candidates, workload.query, limit)
      assert.deepEqual(after(candidates, workload.query, limit), expected)
      const implementations = { before, after }
      const iterations = Math.max(10, Math.floor(100_000 / count))
      for (let warmup = 0; warmup < 100; warmup += 1) {
        before(candidates, workload.query, limit)
        after(candidates, workload.query, limit)
      }
      /** @type {{ before: number[], after: number[] }} */
      const samples = { before: [], after: [] }
      for (const pair of buildCounterbalancedSchedule(8, 'before', 'after')) {
        for (const arm of pair) {
          let actual
          const start = performance.now()
          for (let repeat = 0; repeat < iterations; repeat += 1) {
            actual = implementations[arm](candidates, workload.query, limit)
          }
          samples[arm].push(performance.now() - start)
          assert.deepEqual(actual, expected)
        }
      }
      results.push({
        function: name,
        candidates: candidates.length,
        workload: workload.name,
        iterations,
        meanMicrosecondsPerCall: Object.fromEntries(
          Object.entries(samples).map(([arm, values]) => [
            arm,
            (values.reduce((sum, ms) => sum + ms, 0) * 1000) / values.length / iterations
          ])
        ),
        before: summarizeBenchmarkSamples(samples.before),
        after: summarizeBenchmarkSamples(samples.after)
      })
    }
  }
}
console.log(
  JSON.stringify(
    { node: process.version, platform: process.platform, differentialCases, results },
    null,
    2
  )
)
