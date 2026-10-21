import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { build } from 'esbuild'
import { runProcess } from '@orca/process-host'
import { createCheckLogFixture } from './check-job-log-test-fixture.mjs'
import {
  assertWatchdogExit,
  assertMeasurementRuntime,
  validateChildProtocol,
  adverseCaseKey,
  auditBaselineCensoring
} from './check-job-log-watchdog-protocol.mjs'
import {
  BASELINE_REF,
  BASELINE_SOURCE_HASHES,
  createManifest,
  selectRequiredDescriptors
} from './check-job-log-performance-cases.mjs'

const shared = Object.keys(BASELINE_SOURCE_HASHES)
export const hash = (value) => createHash('sha256').update(value).digest('hex')
export const nodeExecutable = () => {
  const executable = process.versions.bun
    ? (process.env.ORCA_TEST_NODE_EXECUTABLE ?? process.env.npm_node_execpath)
    : process.execPath
  assert(
    executable && path.isAbsolute(executable),
    'A verified absolute Node executable is required'
  )
  return executable
}
const observationSource = `
const counters = {};
export function record(kind, value) {
 const bytes = Buffer.byteLength(value); const item = counters[kind] ??= { calls: 0, maxBytes: 0, totalBytes: 0 };
 item.calls++; item.maxBytes = Math.max(item.maxBytes, bytes); item.totalBytes += bytes;
}
export function observations() { return structuredClone(counters); }
let phase = null;
export function setPhase(value) { phase = value; }
export function enterStrip() { if (phase) { process.stdout.write(JSON.stringify({ type: 'entered-strip', phase }) + '\\n'); phase = null; } }
export function resetObservations() { for (const key of Object.keys(counters)) delete counters[key]; }
`

export async function prepareBenchmark(
  root = process.cwd(),
  { profile = false, compareBaseline = true } = {}
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'orca-check-log-benchmark-'))
  try {
    const baseline = new Map()
    const current = new Map()
    for (const name of [...shared, 'check-job-log-excerpt.ts']) {
      const filename = path.join(root, 'src', 'shared', name)
      current.set(name, await readFile(filename, 'utf8'))
      if (!compareBaseline || !shared.includes(name)) {
        continue
      }
      const result = await runProcess({
        program: 'git',
        args: ['show', `${BASELINE_REF}:src/shared/${name}`],
        cwd: root,
        timeoutMs: 10_000,
        maxOutputBytes: 64 * 1024,
        env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
      })
      assert(
        result.code === 0 && !result.signal && !result.timedOut && !result.outputTruncated,
        'Baseline source snapshot failed'
      )
      baseline.set(name, result.stdout)
      assert.equal(
        hash(result.stdout),
        BASELINE_SOURCE_HASHES[name],
        `Baseline source changed: ${name}`
      )
      if (!shared.slice(0, 2).includes(name)) {
        assert.equal(hash(result.stdout), hash(current.get(name)), `Dependency drift: ${name}`)
      }
    }
    const identity = {
      baselineRef: BASELINE_REF,
      measurementScriptHashes: Object.fromEntries(
        await Promise.all(
          [
            'check-job-log-byte-cap-benchmark.mjs',
            'check-job-log-performance-cases.mjs',
            'check-job-log-test-fixture.mjs',
            'check-job-log-performance-child.mjs',
            'check-job-log-differential-cases.mjs',
            'check-job-log-watchdog-protocol.mjs'
          ].map(async (name) => [
            name,
            hash(await readFile(path.join(root, 'config', 'scripts', name)))
          ])
        )
      ),
      baselineSourceHashes: Object.fromEntries(
        [...baseline].map(([name, value]) => [name, hash(value)])
      ),
      proposedSourceHashes: Object.fromEntries(
        [...current].map(([name, value]) => [name, hash(value)])
      )
    }
    const bundles = {}
    for (const arm of compareBaseline ? ['baseline', 'proposed'] : ['proposed']) {
      for (const instrumented of arm === 'baseline' ? [false, true, 'negative'] : [false, true]) {
        const sources = arm === 'baseline' ? baseline : current
        const result = await build({
          stdin: {
            contents: `export { sliceCheckLogTail } from './check-job-log-tail-slice'; export { stripAnsiEscapeSequences, TERMINAL_CONTROL_CHARACTER_PATTERN } from './ansi-escape-sequences'; export { ownRetainedString, resetOwnRetainedStringCopier } from './own-retained-string'; ${arm === 'proposed' ? "export { sanitizeCheckJobLogExcerpt } from './check-job-log-excerpt';" : ''} ${profile && arm === 'proposed' ? "export { hasErrorMarker } from './check-job-log-tail-slice'; export { stripControlStrings } from './ansi-escape-sequences'; export { isUtf8ByteLengthWithinLimit } from './utf8-byte-limits';" : ''} export { observations, resetObservations, setPhase } from 'check-log-observations';`,
            resolveDir: path.join(root, 'src', 'shared'),
            loader: 'ts'
          },
          bundle: true,
          platform: 'node',
          format: 'esm',
          write: false,
          plugins: [
            {
              name: 'source-pinned-log-text',
              setup(builder) {
                builder.onResolve({ filter: /^check-log-observations$/ }, () => ({
                  path: 'check-log-observations',
                  namespace: 'observations'
                }))
                builder.onLoad({ filter: /.*/, namespace: 'observations' }, () => ({
                  contents: observationSource,
                  loader: 'js'
                }))
                builder.onLoad(
                  {
                    filter:
                      /[\\/](?:ansi-escape-sequences|check-job-log-tail-slice|check-job-log-excerpt|utf8-byte-limits|own-retained-string|owned-utf16-suffix)\.ts$/
                  },
                  ({ path: filename }) => {
                    const name = path.basename(filename)
                    let contents = sources.get(name)
                    assert(contents, `Unexpected module in ${arm} graph: ${name}`)
                    if (profile && arm === 'proposed') {
                      contents = contents
                        .replace('function hasErrorMarker(', 'export function hasErrorMarker(')
                        .replace(
                          'function stripControlStrings(',
                          'export function stripControlStrings('
                        )
                    }
                    if (instrumented === 'negative') {
                      if (name === 'ansi-escape-sequences.ts') {
                        contents =
                          `import { enterStrip } from 'check-log-observations';\n${contents}`.replace(
                            'export function stripAnsiEscapeSequences(value: string): string {',
                            'export function stripAnsiEscapeSequences(value: string): string {\nenterStrip();'
                          )
                      }
                    } else if (instrumented) {
                      contents = `import { record as __record } from 'check-log-observations';\n${contents}`
                      if (name === 'ansi-escape-sequences.ts') {
                        contents = contents.replace(
                          'export function stripAnsiEscapeSequences(value: string): string {',
                          'export function stripAnsiEscapeSequences(value: string): string {\n__record("strip", value);'
                        )
                      }
                      if (name === 'utf8-byte-limits.ts') {
                        contents = contents.replace(
                          'export function getUtf8ByteLength(text: string): number {',
                          'export function getUtf8ByteLength(text: string): number {\n__record("exact", text);'
                        )
                      }
                      if (name === 'check-job-log-tail-slice.ts') {
                        assert.equal(
                          contents.split('ERROR_LINE_PATTERN.test(').length,
                          2,
                          'Actual matcher injection changed'
                        )
                        contents = `${contents
                          .replace(
                            'stripAnsiEscapeSequences(candidate)',
                            '(__record("candidate", candidate), stripAnsiEscapeSequences(candidate))'
                          )
                          .replace(
                            'ERROR_LINE_PATTERN.test(',
                            '__match('
                          )}\nfunction __match(value: string): boolean { __record("matcher", value); return ERROR_LINE_PATTERN.test(value); }`
                      }
                    }
                    return { contents, loader: 'ts', resolveDir: path.dirname(filename) }
                  }
                )
              }
            }
          ]
        })
        const text = result.outputFiles[0].text
        const key = `${arm}${instrumented === 'negative' ? '-negative' : instrumented ? '-observed' : ''}`
        const filename = path.join(directory, `${key}.mjs`)
        await writeFile(filename, text)
        bundles[key] = { filename, hash: hash(text) }
      }
    }
    return {
      root,
      directory,
      identity,
      bundles,
      cleanup: () => rm(directory, { recursive: true, force: true })
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

export async function runDescriptor(context, descriptor) {
  const baseline = ['baseline', 'baseline-bounded', 'full-log'].includes(descriptor.arm)
  const key = `${baseline ? 'baseline' : 'proposed'}${descriptor.baselineTimeoutAllowed ? '-negative' : descriptor.mode === 'coverage' ? '-observed' : ''}`
  const bundle = context.bundles[key]
  const identity = { ...context.identity, bundleHash: bundle.hash, id: descriptor.id }
  const censored = (context.censoredBaselines ??= new Map())
  const initialTimeout = descriptor.baselineTimeoutAllowed
    ? censored.get(adverseCaseKey(descriptor))
    : undefined
  if (initialTimeout && descriptor.sample > 0) {
    assertWatchdogExit(initialTimeout.watchdogTermination)
    assertMeasurementRuntime(initialTimeout.runtime)
    return {
      ...descriptor,
      capturePath: undefined,
      status: 'baseline_censored',
      attempted: false,
      initialTimeoutId: initialTimeout.id,
      identity,
      runtime: initialTimeout.runtime,
      inputBytes: initialTimeout.inputBytes,
      codeUnits: initialTimeout.codeUnits,
      inputHash: initialTimeout.inputHash,
      unavailableSamples: descriptor.samples,
      samples: []
    }
  }
  const started = performance.now()
  const controller = new AbortController()
  let outerTimer
  const outer = new Promise((_resolve, reject) => {
    outerTimer = setTimeout(() => {
      controller.abort()
      reject(new Error('Child exceeded its outer settlement budget'))
    }, 15_000)
  })
  let result
  try {
    result = await Promise.race([
      runProcess({
        signal: controller.signal,
        program: nodeExecutable(),
        args: [
          '--expose-gc',
          path.join(context.root, 'config', 'scripts', 'check-job-log-performance-child.mjs'),
          bundle.filename,
          JSON.stringify(descriptor),
          JSON.stringify(identity)
        ],
        cwd: context.root,
        env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
        timeoutMs: 10_000,
        maxOutputBytes: 64 * 1024
      }),
      outer
    ])
  } finally {
    clearTimeout(outerTimer)
  }
  const settlementMs = performance.now() - started
  assert(settlementMs < 15_000, 'Child exceeded its outer settlement budget')
  assert(!result.outputTruncated, 'Child protocol truncated')
  assert(result.stderr.length === 0, 'Child emitted unexpected stderr')
  const { ready, entered, completed, warmups } = validateChildProtocol(result.stdout, descriptor)
  assert(!result.timedOut || completed.length === 0, 'Completed work cannot be censored')
  assert(
    ready && ready.identity.id === descriptor.id && ready.identity.bundleHash === bundle.hash,
    'Missing or mismatched pre-work identity'
  )
  assert.deepEqual(ready.identity, identity)
  assert.equal(ready.identity.baselineRef, BASELINE_REF)
  assert(Number.isSafeInteger(ready.inputBytes) && ready.inputBytes >= 0)
  assert(Number.isSafeInteger(ready.codeUnits) && ready.codeUnits >= 0)
  assert(ready.inputBytes >= ready.codeUnits && ready.inputBytes <= ready.codeUnits * 3)
  assert(typeof ready.inputHash === 'string' && /^[a-f0-9]{64}$/.test(ready.inputHash))
  if (
    descriptor.mode === 'direct' ||
    descriptor.mode === 'counts' ||
    (descriptor.mode === 'cpu' && descriptor.family === 'short-lines')
  ) {
    assert.equal(ready.inputBytes, descriptor.bytes, 'Generator byte size changed')
  }
  if (descriptor.mode === 'cpu' && ['actual', 'fixture'].includes(descriptor.family)) {
    const input =
      descriptor.family === 'actual'
        ? await readFile(descriptor.capturePath, 'utf8')
        : createCheckLogFixture().rawLog
    assert.equal(ready.inputBytes, Buffer.byteLength(input), 'Captured input bytes changed')
    assert.equal(ready.codeUnits, input.length, 'Captured input code units changed')
    assert.equal(ready.inputHash, hash(input), 'Captured input hash changed')
  }
  if (descriptor.mode === 'watchdog') {
    assert.equal(entered?.phase, 'watchdog', 'Watchdog did not enter the synchronous child')
    assertWatchdogExit(result)
    return {
      ...descriptor,
      status: 'watchdog_passed',
      attempted: true,
      settlementMs,
      signal: result.signal,
      code: result.code,
      watchdogTermination: { timedOut: true, signal: result.signal, code: result.code },
      identity,
      inputBytes: ready.inputBytes,
      codeUnits: ready.codeUnits,
      inputHash: ready.inputHash,
      runtime: ready.runtime
    }
  }
  if (result.timedOut && descriptor.baselineTimeoutAllowed) {
    assertWatchdogExit(result)
    assert(
      descriptor.mode === 'direct' &&
        descriptor.arm === 'baseline' &&
        entered &&
        ['warmup', 'sample'].includes(entered.phase),
      'Invalid adverse baseline censoring'
    )
    const record = {
      ...descriptor,
      capturePath: undefined,
      status: 'baseline_timeout',
      identity,
      runtime: ready.runtime,
      inputBytes: ready.inputBytes,
      codeUnits: ready.codeUnits,
      inputHash: ready.inputHash,
      phase: entered.phase,
      deadlineMs: 10_000,
      settlementMs,
      watchdogTermination: { timedOut: true, signal: result.signal, code: result.code },
      unavailableSamples: descriptor.samples,
      samples: []
    }
    record.attempted = true
    if (descriptor.sample === 0) {
      censored.set(adverseCaseKey(descriptor), record)
    }
    return record
  }
  assert(
    !result.timedOut && result.code === 0 && !result.signal,
    'Workload child failed or timed out'
  )
  assert.equal(completed.length, 1, 'Missing result protocol')
  if (descriptor.mode === 'direct' || descriptor.mode === 'cpu') {
    assert.equal(completed[0].samples.length, descriptor.samples, 'Incomplete timed samples')
    assert.equal(warmups, descriptor.warmups ?? 3)
    for (const sample of completed[0].samples) {
      assert(Number.isSafeInteger(sample.calls) && sample.calls > 0)
      for (const value of [
        sample.wallMs,
        sample.cpu.user,
        sample.cpu.system,
        sample.timerLatenessMs,
        sample.histogramMaxMs,
        sample.utilization.active,
        sample.utilization.idle,
        sample.utilization.utilization
      ]) {
        assert(Number.isFinite(value) && value >= 0)
      }
      assert(sample.utilization.active > 0 && sample.utilization.utilization <= 1)
      assert(sample.samplesBeforeWork > 0 && sample.finalCount > sample.postWorkCount)
      if (descriptor.mode === 'direct' && descriptor.bytes <= 32768) {
        assert(sample.wallMs >= 30, 'Tiny input batch did not reach its timing floor')
      }
    }
  }
  return {
    ...descriptor,
    capturePath: undefined,
    ...completed[0],
    ...completed[0].inputIdentity,
    identity,
    runtime: ready.runtime,
    settlementMs,
    status: 'completed',
    attempted: true
  }
}

export function median(values) {
  assert(values.length > 0 && values.every(Number.isFinite), 'Missing finite timing samples')
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

export function auditResults(manifest, records, { compareBaseline = true } = {}) {
  assert.equal(
    new Set(manifest.map((item) => item.id)).size,
    manifest.length,
    'Duplicate manifest IDs'
  )
  assert.equal(records.length, manifest.length, 'Incomplete or duplicate descriptor coverage')
  const byId = new Map(records.map((record) => [record.id, record]))
  assert.equal(byId.size, manifest.length, 'Incomplete or duplicate descriptor coverage')
  const expectedIds = new Set(manifest.map((item) => item.id))
  assert(
    records.every((record) => expectedIds.has(record.id)),
    'Unexpected descriptor record'
  )
  for (const descriptor of manifest) {
    const record = byId.get(descriptor.id)
    assert(
      record &&
        ['completed', 'baseline_timeout', 'baseline_censored', 'watchdog_passed'].includes(
          record.status
        ),
      `Failed descriptor: ${descriptor.id}`
    )
    for (const field of ['mode', 'arm', 'family', 'width', 'bytes', 'sample']) {
      assert.equal(record[field], descriptor[field], `Descriptor identity changed: ${field}`)
    }
    if (descriptor.arm === 'proposed') {
      assert(!['baseline_timeout', 'baseline_censored'].includes(record.status))
    }
  }
  auditBaselineCensoring(manifest, byId)
  const differentials = records.filter((record) => record.mode === 'differential')
  assert.equal(differentials.length, compareBaseline ? 2 : 1)
  assert.equal(differentials[0].cases, 5126)
  if (compareBaseline) {
    assert.equal(
      differentials[0].outputHash,
      differentials[1].outputHash,
      'Plain/LF differential changed'
    )
  }
  const candidateGroups = new Map()
  for (const descriptor of manifest.filter(
    (item) => item.mode === 'coverage' && item.arm === 'proposed' && item.bytes >= 32 * 1024
  )) {
    const key = `${descriptor.family}:${descriptor.width}:${descriptor.position}:${descriptor.variant}:${descriptor.terminator}`
    const values = candidateGroups.get(key) ?? []
    values.push(byId.get(descriptor.id).observations.candidate)
    candidateGroups.set(key, values)
  }
  for (const values of candidateGroups.values()) {
    assert(values.every((value) => value && value.maxBytes <= 8192))
    assert(
      Math.max(...values.map((value) => value.totalBytes)) <=
        Math.min(...values.map((value) => value.totalBytes)) + 64,
      'Candidate bytes grew with a raw line'
    )
    assert(
      Math.max(...values.map((value) => value.calls)) ===
        Math.min(...values.map((value) => value.calls)),
      'Candidate calls grew with a raw line'
    )
  }
  const scaling = []
  const groups = new Map()
  for (const descriptor of manifest.filter(
    (item) => item.mode === 'direct' && item.arm === 'proposed'
  )) {
    const key = `${descriptor.family}:${descriptor.width}`
    const sizes = groups.get(key) ?? new Map()
    const values = sizes.get(descriptor.bytes) ?? []
    values.push(...byId.get(descriptor.id).samples.map((sample) => sample.wallMs / sample.calls))
    sizes.set(descriptor.bytes, values)
    groups.set(key, sizes)
  }
  for (const [family, sizes] of groups) {
    const keys = [...sizes.keys()].sort((a, b) => a - b)
    for (let index = 0; index < keys.length; index += 2) {
      const small = sizes.get(keys[index])
      const large = sizes.get(keys[index + 1])
      assert.equal(small.length, 7)
      assert.equal(large.length, 7)
      const first = median(small)
      const second = median(large)
      assert(second <= 3 * first + 1, `Linear doubling gate failed: ${family} ${keys[index]}`)
      scaling.push({ family, bytes: keys.slice(index, index + 2), medianMs: [first, second] })
    }
  }
  const retained = records.filter((record) => record.mode === 'retention')
  const pinned = retained.find((record) => record.arm === 'pinned')
  for (const record of retained.filter(
    (item) => item.family === 'eight-parents' && item.arm !== 'pinned'
  )) {
    assert(record.growth.heapUsed < 4 * 1024 * 1024)
    assert(record.growth.heapUsed < pinned.growth.heapUsed / 8, 'Owned strings pin raw parents')
  }
  const ordinary = []
  for (const family of compareBaseline ? ['actual', 'fixture', 'short-lines'] : []) {
    for (const bytes of new Set(
      manifest
        .filter((item) => item.mode === 'cpu' && item.family === family)
        .map((item) => item.bytes)
    )) {
      const comparisons = {}
      for (const arm of ['baseline', 'proposed', 'baseline-bounded', 'full-log']) {
        const measured = records
          .filter(
            (record) =>
              record.mode === 'cpu' &&
              record.family === family &&
              record.bytes === bytes &&
              record.arm === arm
          )
          .flatMap((record) => record.samples)
        comparisons[arm] = {
          wallMs: median(measured.map((sample) => sample.wallMs)),
          cpuMs: median(measured.map((sample) => (sample.cpu.user + sample.cpu.system) / 1000)),
          timerLatenessMs: median(measured.map((sample) => sample.timerLatenessMs))
        }
      }
      const before = comparisons.baseline
      const after = comparisons.proposed
      const threshold = bytes === 63 * 1024 * 1024 ? 15 : 5
      const review = ['wallMs', 'cpuMs', 'timerLatenessMs'].some(
        (key) => after[key] > before[key] * 1.25 && after[key] - before[key] > threshold
      )
      ordinary.push({ family, bytes, comparisons, reviewRequired: review })
    }
  }
  return {
    descriptors: manifest.length,
    proposed: manifest.filter((item) => item.arm === 'proposed').length,
    censoredBaselines: records.filter((record) => record.status === 'baseline_timeout').length,
    censoredSampleSlots: records.filter((record) => record.status === 'baseline_censored').length,
    attemptedDescriptors: records.filter((record) => record.attempted !== false).length,
    scaling,
    ordinary
  }
}

// Manual before/after comparison requires the pinned baseline in local Git history.
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const context = await prepareBenchmark()
  const manifest = selectRequiredDescriptors(
    createManifest({ capturePath: process.env.ORCA_CHECK_LOG_CAPTURE })
  )
  const records = []
  try {
    for (const descriptor of manifest) {
      try {
        records.push(await runDescriptor(context, descriptor))
      } catch (error) {
        records.push({ id: descriptor.id, status: 'failed', reason: error.message.split('\n')[0] })
      }
      if (process.env.ORCA_CHECK_LOG_REPORT) {
        await writeFile(
          process.env.ORCA_CHECK_LOG_REPORT,
          JSON.stringify({ identity: context.identity, records })
        )
      }
    }
    const summary = auditResults(manifest, records)
    if (process.env.ORCA_CHECK_LOG_REPORT) {
      await writeFile(
        process.env.ORCA_CHECK_LOG_REPORT,
        JSON.stringify({ identity: context.identity, summary, records })
      )
    }
    console.log(JSON.stringify(summary))
  } finally {
    await context.cleanup()
  }
}
