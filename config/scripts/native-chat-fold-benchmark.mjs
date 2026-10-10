import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { build } from 'esbuild'
import { buildCounterbalancedSchedule } from './counterbalanced-benchmark-schedule.mjs'
import { summarizeBenchmarkSamples } from './benchmark-sample-summary.mjs'
import { runProcessSync } from '@orca/process-host'
import { describeProcessFailure } from './process-failure-message.mjs'
import {
  assertFoldConservesEvidence,
  countFoldOperations,
  createFoldWorkloads,
  summarizeFoldOutput
} from './native-chat-fold-benchmark-workloads.mjs'

// ORCA_BACKGROUND_LAUNCH=1 node --expose-gc config/scripts/native-chat-fold-benchmark.mjs > full-fold.json
const root = path.resolve(import.meta.dirname, '../..')
const refs = {
  original: '51e7181850b022bae2d41091fe1229accef4bd50',
  published: 'b1e44269d655608447dc535f0a4d7d05c37c80b7',
  current: null
}
const entry = `
  export { foldToolMessages as fold } from './src/shared/native-chat-tool-fold'
  import { createNativeChatMessageListProjection } from './src/renderer/src/components/native-chat/native-chat-message-list-projection'
  import { deriveNativeChatRowContent } from './src/shared/native-chat-row-content'
  import { pairNativeChatToolResults } from './src/shared/native-chat-tool-pairing'
  export function createPipeline() {
    const project = createNativeChatMessageListProjection()
    return (messages) => {
      const projection = project(messages)
      const rows = [...projection.conversation, ...Array.from(projection.subagentRows.values()).flat().map(row => row.message)]
      const paired = rows.flatMap(row => {
        const tools = deriveNativeChatRowContent(row.blocks).tools
        return tools.length > 0 ? [pairNativeChatToolResults(tools)] : []
      })
      return { rows, projection, paired }
    }
  }
`
const hash = (source) => createHash('sha256').update(source).digest('hex')

function measureOutputMemory(run, messages, check) {
  global.gc()
  const before = process.memoryUsage().heapUsed
  const output = run(messages)
  const afterRun = process.memoryUsage().heapUsed
  global.gc()
  const retained = process.memoryUsage().heapUsed
  check(output)
  return {
    transientHeapDeltaBytes: afterRun - before,
    retainedHeapDeltaBytes: retained - before
  }
}

if (process.argv.includes('--memory-control')) {
  const samples = Array.from({ length: 5 }, () =>
    measureOutputMemory(
      () => Array.from({ length: 1_000_000 }, () => 0),
      undefined,
      (output) => assert.equal(output.length, 1_000_000)
    )
  )
  assert.ok(samples.every((sample) => sample.retainedHeapDeltaBytes > 2_000_000))
  console.log(JSON.stringify({ arraySlots: 1_000_000, samples }, null, 2))
  process.exit(0)
}

async function load(ref) {
  const modules = new Map()
  const built = await build({
    stdin: {
      contents: entry,
      resolveDir: root,
      sourcefile: 'fold-benchmark-entry.ts',
      loader: 'ts'
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    plugins: [
      {
        name: 'exact-chat-source-snapshot',
        setup(builder) {
          builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, ({ path: file }) => {
            const relative = path.relative(root, file).split(path.sep).join('/')
            if (!relative.startsWith('src/')) {
              return undefined
            }
            let source
            if (ref) {
              const read = runProcessSync({
                program: 'git',
                args: ['show', `${ref}:${relative}`],
                cwd: root,
                env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
                timeoutMs: 30_000,
                maxOutputBytes: 2 * 1024 * 1024
              })
              if (read.code !== 0 || read.timedOut || read.outputTruncated) {
                throw new Error(describeProcessFailure(read))
              }
              source = read.stdout
            } else {
              source = readFileSync(file, 'utf8')
            }
            modules.set(relative, hash(source))
            return { contents: source, loader: file.endsWith('tsx') ? 'tsx' : 'ts' }
          })
        }
      }
    ]
  })
  const code = built.outputFiles[0].text
  return {
    ...(await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)),
    bundleSha256: hash(code),
    moduleSha256: Object.fromEntries(
      [...modules].sort(([left], [right]) => left.localeCompare(right))
    )
  }
}

if (!global.gc) {
  throw new Error('Memory measurements require node --expose-gc')
}
const loaded = Object.fromEntries(
  await Promise.all(Object.entries(refs).map(async ([arm, ref]) => [arm, await load(ref)]))
)
const bundles = Object.fromEntries(
  Object.entries(loaded).map(([arm, source]) => [
    arm,
    {
      bundleSha256: source.bundleSha256,
      moduleSha256: source.moduleSha256
    }
  ])
)
if (process.argv.includes('--prepare-only')) {
  console.log(JSON.stringify({ refs, bundles }, null, 2))
  process.exit(0)
}
const stages = ['fold', 'projection-and-pairing', 'refold']
const results = []

function operation(arm, stage, messages) {
  if (stage === 'projection-and-pairing') {
    return loaded[arm].createPipeline()
  }
  if (stage === 'refold') {
    const folded = loaded[arm].fold(messages)
    return () => loaded[arm].fold(folded)
  }
  return loaded[arm].fold
}

const rowsOf = (stage, output) => (stage === 'projection-and-pairing' ? output.rows : output)
for (const count of [32, 512, 8192]) {
  for (const workload of createFoldWorkloads(count)) {
    assert.deepEqual(
      loaded.current.fold(workload.messages),
      loaded.published.fold(workload.messages)
    )
    const summaries = Object.fromEntries(
      Object.keys(loaded).map((arm) => {
        const folded = loaded[arm].fold(workload.messages)
        if (arm !== 'original') {
          assertFoldConservesEvidence(workload.messages, folded)
          assert.deepEqual(loaded[arm].fold(folded), folded)
        }
        return [arm, summarizeFoldOutput(folded)]
      })
    )
    for (const stage of stages) {
      const operations = Object.fromEntries(
        Object.keys(loaded).map((arm) => [arm, operation(arm, stage, workload.messages)])
      )
      const expected = Object.fromEntries(
        Object.keys(loaded).map((arm) => [arm, operations[arm](workload.messages)])
      )
      for (let warmup = 0; warmup < 3; warmup += 1) {
        for (const arm of Object.keys(loaded)) {
          operations[arm](workload.messages)
        }
      }
      const iterations = count === 32 ? 16 : count === 512 ? 2 : 1
      const comparisons = []
      for (const baseline of ['original', 'published']) {
        const samples = { [baseline]: [], current: [] }
        for (const pair of buildCounterbalancedSchedule(6, baseline, 'current')) {
          for (const arm of pair) {
            let output
            const started = performance.now()
            for (let repeat = 0; repeat < iterations; repeat += 1) {
              output = operations[arm](workload.messages)
            }
            samples[arm].push((performance.now() - started) / iterations)
            assert.deepEqual(rowsOf(stage, output), rowsOf(stage, expected[arm]))
          }
        }
        comparisons.push({
          baseline,
          iterationsPerSample: iterations,
          samplesMs: samples,
          summary: Object.fromEntries(
            Object.entries(samples).map(([arm, values]) => [arm, summarizeBenchmarkSamples(values)])
          )
        })
      }
      const operationsCount = {}
      const memory = {}
      for (const arm of Object.keys(loaded)) {
        const reads = { count: 0 }
        const counted = createFoldWorkloads(count, reads).find(
          (entry) => entry.name === workload.name
        )
        const countedRun = operation(arm, stage, counted.messages)
        const measured = countFoldOperations(countedRun, counted.messages, reads)
        operationsCount[arm] = {
          pairWrappers: measured.pairWrappers,
          callIdReads: measured.callIdReads
        }
        const samples = []
        for (let sample = 0; sample < 5; sample += 1) {
          const run = operation(arm, stage, workload.messages)
          samples.push(
            measureOutputMemory(run, workload.messages, (output) =>
              assert.deepEqual(rowsOf(stage, output), rowsOf(stage, expected[arm]))
            )
          )
        }
        memory[arm] = samples
      }
      results.push({
        count,
        inputRows: workload.messages.length,
        workload: workload.name,
        stage,
        summaries,
        operationsCount,
        memorySamples: memory,
        comparisons
      })
    }
    process.stderr.write(`Measured ${workload.name} at ${count}\n`)
  }
}
console.log(
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      refs,
      bundles,
      scope:
        'Production full tool fold; settled desktop transcript projection and all-row render-data derivation/pairing; repeated fold. The consumer stage models every tool run opened, while real desktop windowing normally mounts only viewport rows. No React commits, DOM layout, Electron frames, mobile runtime or network latency.',
      memoryMethod:
        'Each sample runs in an isolated function so its output dies before the next before-GC. Projection memory uses a fresh projector/cache, while timing reuses a settled projector. Forced-GC heapUsed before/after with output and current run cache held alive; transient deltas are allocation-pressure samples, not peak heap or total allocated bytes. Shared source inputs are excluded. Negative retained deltas are measurement noise, not savings or per-update growth.',
      correctness:
        'Published/current fold outputs deeply equal for every workload; both conserve all call/result block references, have unique row IDs, and remain deeply identical on refold. Timing samples match each version own output outside the timed interval.',
      originalCorrectness:
        'Original may drop named orphans or preserve them under unrelated calls; output counts report differences. Timing comparisons do not imply equivalent visible output.',
      results
    },
    null,
    2
  )
)
