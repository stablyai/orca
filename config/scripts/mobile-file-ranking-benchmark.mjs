import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { build } from 'esbuild'
import { runProcessSync } from '@orca/process-host'
import { buildCounterbalancedSchedule } from './counterbalanced-benchmark-schedule.mjs'
import { summarizeBenchmarkSamples } from './benchmark-sample-summary.mjs'
import { describeProcessFailure } from './process-failure-message.mjs'

const baseline = process.argv[2]
if (!baseline) {
  throw new Error(
    'Usage: node config/scripts/mobile-file-ranking-benchmark.mjs <baseline-ref|--autocomplete-stdin>'
  )
}
// git show <ref>:mobile/src/session/mobile-native-chat-autocomplete.ts | node config/scripts/mobile-file-ranking-benchmark.mjs --autocomplete-stdin
const autocompleteSource = baseline === '--autocomplete-stdin' ? readFileSync(0, 'utf8') : null
const root = path.resolve(import.meta.dirname, '../..')
function git(args) {
  return runProcessSync({
    program: 'git',
    args,
    cwd: root,
    timeoutMs: 30_000,
    maxOutputBytes: 2 * 1024 * 1024
  })
}
function readGit(args) {
  const result = git(args)
  if (result.code !== 0 || result.timedOut || result.outputTruncated) {
    throw new Error(describeProcessFailure(result))
  }
  return result.stdout
}
const baselineCommit =
  autocompleteSource === null
    ? readGit(['rev-parse', '--verify', `${baseline}^{commit}`]).trim()
    : null
function resolveBaselineFile(candidates) {
  for (const file of candidates) {
    const result = git(['cat-file', '-t', `${baselineCommit}:${file}`])
    if (result.timedOut || result.outputTruncated || ![0, 128].includes(result.code)) {
      throw new Error(describeProcessFailure(result))
    }
    if (result.code === 0 && result.stdout.trim() === 'blob') {
      return file
    }
  }
  throw new Error(`Missing baseline source: ${candidates.join(', ')}`)
}
/**
 * @param {string} file
 * @param {string | null} ref
 * @param {string | null} source
 */
async function load(file, ref = null, source = null) {
  const { outputFiles } = await build({
    ...(source === null
      ? { entryPoints: [file] }
      : {
          stdin: {
            contents: source,
            sourcefile: file,
            resolveDir: path.dirname(path.resolve(root, file)),
            loader: 'ts'
          }
        }),
    absWorkingDir: root,
    bundle: source === null,
    tsconfigRaw: {},
    write: false,
    platform: 'node',
    format: 'esm',
    plugins:
      ref === null
        ? []
        : [
            {
              name: 'exact-baseline-ranking-source',
              setup(builder) {
                builder.onResolve({ filter: /.*/ }, (args) => {
                  if (args.kind === 'entry-point') {
                    return { path: file, namespace: 'git-baseline' }
                  }
                  if (args.namespace !== 'git-baseline') {
                    return undefined
                  }
                  if (!args.path.startsWith('.')) {
                    return { path: args.path, external: true }
                  }
                  const target = path.posix.join(path.posix.dirname(args.importer), args.path)
                  return {
                    path: resolveBaselineFile([
                      target,
                      `${target}.ts`,
                      `${target}.tsx`,
                      `${target}.js`,
                      `${target}/index.ts`
                    ]),
                    namespace: 'git-baseline'
                  }
                })
                builder.onLoad({ filter: /.*/, namespace: 'git-baseline' }, (args) => ({
                  contents: readGit(['show', `${ref}:${args.path}`]),
                  loader: args.path.endsWith('.tsx') ? 'tsx' : 'ts'
                }))
              }
            }
          ]
  })
  const code = outputFiles[0].text
  return await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
}
const results = []
let differentialCases = 0
for (const [file, name] of [
  ['src/main/runtime/files/search/mobile-path-search.ts', 'rankRuntimeMobileFilePaths'],
  ['mobile/src/session/mobile-native-chat-autocomplete.ts', 'rankSuggestions']
]) {
  if (autocompleteSource !== null && name === 'rankRuntimeMobileFilePaths') {
    continue
  }
  const baselineFile =
    autocompleteSource === null
      ? resolveBaselineFile(
          name === 'rankRuntimeMobileFilePaths'
            ? [file, 'src/main/runtime/runtime-mobile-file-path-search.ts']
            : [file]
        )
      : file
  const before = (await load(baselineFile, baselineCommit, autocompleteSource))[name]
  const after = (await load(file))[name]
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
      const candidates = Array.from(
        { length: random(100) },
        () => tokens[random(tokens.length)] + tokens[random(tokens.length)]
      )
      const query = tokens[random(tokens.length)]
      const limit = limits[random(limits.length)]
      assert.deepEqual(after(candidates, query, limit), before(candidates, query, limit))
      differentialCases += 1
    }
  }
  for (const count of [16, 100, 10_000, 50_000, 100_000]) {
    const names = Array.from(
      { length: count },
      (_, index) => `src/components/workspace/group-${index % 100}/file-${index}.tsx`
    )
    const limit = 16
    const substringQuery = 'workspace'
    const workloads = [
      { name: 'empty-query', names, query: '' },
      { name: 'substring', names, query: substringQuery },
      { name: 'no-match', names, query: 'missing' },
      { name: 'early-prefix', names, query: 'file' },
      {
        name: 'late-prefix',
        names: [...names, ...Array.from({ length: 4 }, (_, index) => `${substringQuery}-${index}`)],
        query: substringQuery
      }
    ]
    for (const workload of workloads) {
      const candidates = workload.names
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
