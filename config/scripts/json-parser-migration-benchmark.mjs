import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createReadStream, readFileSync, statSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildCounterbalancedSchedule } from './counterbalanced-benchmark-schedule.mjs'
import { summarizeBenchmarkSamples } from './benchmark-sample-summary.mjs'
import { JSON_PARSER_CASES, writeJsonParserFixtures } from './json-parser-benchmark-fixtures.mjs'

// Bundle each revision's two consumers as {baseline,candidate}-{rg,session}.mjs first.
const [bundleDirectory, workerFixture, workerArm] = process.argv.slice(2)
if (!bundleDirectory || !global.gc) {
  throw new Error('Usage: node --expose-gc json-parser-migration-benchmark.mjs BUNDLE_DIRECTORY')
}

async function load(arm, kind) {
  return import(pathToFileURL(resolve(bundleDirectory, `${arm}-${kind}.mjs`)).href)
}

function prepareRun(module, fixture, file) {
  if (fixture.kind === 'rg') {
    const text = readFileSync(file, 'utf8')
    return () =>
      module.parseRipgrepMatchJson(text, fixture.cap, {
        structuralTokens: 32 * 1024,
        nestingDepth: 16
      })
  }
  return () =>
    module.readStreamedSessionDocument({
      bytes: createReadStream(file, { highWaterMark: 64 * 1024 }),
      arrayKey: 'messages',
      fields: ['id'],
      objectFields: { agent: ['model'] },
      create: () => ({ count: 0, textLength: 0 }),
      consume(state, value) {
        state.count++
        state.textLength += typeof value?.text === 'string' ? value.text.length : 0
      }
    })
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

async function consumedContentDigest(module, file) {
  const result = await module.readStreamedSessionDocument({
    bytes: createReadStream(file, { highWaterMark: 64 * 1024 }),
    arrayKey: 'messages',
    fields: ['id'],
    objectFields: { agent: ['model'] },
    create: () => createHash('sha256'),
    consume(hash, value) {
      hash.update(JSON.stringify(value)).update('\n')
    }
  })
  return { record: result.record, consumedSha256: result.state.digest('hex') }
}

if (workerFixture) {
  const fixture = JSON_PARSER_CASES.find((item) => workerFixture.endsWith(`${item.name}.json`))
  assert(fixture)
  const module = await load(workerArm, fixture.kind)
  const run = prepareRun(module, fixture, workerFixture)
  global.gc()
  const before = process.memoryUsage()
  let running = true
  let maxLoopGapMs = 0
  let previous = performance.now()
  const observe = () => {
    const now = performance.now()
    maxLoopGapMs = Math.max(maxLoopGapMs, now - previous)
    previous = now
    if (running) {
      setImmediate(observe)
    }
  }
  setImmediate(observe)
  const started = performance.now()
  const result = await run()
  const elapsedMs = performance.now() - started
  await new Promise((done) => setImmediate(done))
  running = false
  const peakRssMiB = process.resourceUsage().maxRSS / 1024
  global.gc()
  const retainedHeapDeltaMiB = (process.memoryUsage().heapUsed - before.heapUsed) / 1024 ** 2
  console.log(
    JSON.stringify({
      elapsedMs,
      peakRssMiB,
      retainedHeapDeltaMiB,
      maxLoopGapMs,
      digest: digest(result)
    })
  )
} else {
  const directory = mkdtempSync(join(tmpdir(), 'orca-json-parser-benchmark-'))
  try {
    writeJsonParserFixtures(directory)
    global.gc()
    const results = []
    for (const fixture of JSON_PARSER_CASES) {
      const file = join(directory, `${fixture.name}.json`)
      const runs = {}
      const contents = {}
      for (const arm of ['baseline', 'candidate']) {
        const module = await load(arm, fixture.kind)
        runs[arm] = prepareRun(module, fixture, file)
        if (fixture.kind === 'session') {
          contents[arm] = await consumedContentDigest(module, file)
        }
      }
      assert.deepEqual(contents.candidate, contents.baseline)
      for (let warmup = 0; warmup < 3; warmup++) {
        assert.deepEqual(await runs.candidate(), await runs.baseline())
      }
      const samples = { baseline: [], candidate: [] }
      for (const pair of buildCounterbalancedSchedule(12, 'baseline', 'candidate')) {
        for (const arm of pair) {
          const started = performance.now()
          await runs[arm]()
          samples[arm].push(performance.now() - started)
        }
      }
      const memory = { baseline: [], candidate: [] }
      for (const pair of buildCounterbalancedSchedule(2, 'baseline', 'candidate')) {
        for (const arm of pair) {
          const child = spawnSync(
            process.execPath,
            ['--expose-gc', import.meta.filename, bundleDirectory, file, arm],
            {
              encoding: 'utf8',
              env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
              windowsHide: true
            }
          )
          assert.equal(child.status, 0, child.stderr)
          memory[arm].push(JSON.parse(child.stdout))
        }
      }
      for (const sample of [...memory.baseline, ...memory.candidate]) {
        assert.equal(sample.digest, memory.baseline[0].digest)
      }
      results.push({
        name: fixture.name,
        bytes: statSync(file).size,
        baseline: summarizeBenchmarkSamples(samples.baseline),
        candidate: summarizeBenchmarkSamples(samples.candidate),
        samples,
        memory
      })
    }
    console.log(
      JSON.stringify(
        { node: process.version, platform: process.platform, arch: process.arch, results },
        null,
        2
      )
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
