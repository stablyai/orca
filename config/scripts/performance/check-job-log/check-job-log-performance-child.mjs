import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { plainLogDifferentialCases } from './check-job-log-differential-cases.mjs'
import { LIMIT, workload } from './check-job-log-performance-cases.mjs'
import { createCheckLogFixture } from './check-job-log-test-fixture.mjs'

assert(!process.versions.bun, 'Measurement child must use Node')
const [bundlePath, serialized, identityJson] = process.argv.slice(2)
const descriptor = JSON.parse(serialized)
const identity = JSON.parse(identityJson)
const digest = (value) => createHash('sha256').update(value).digest('hex')
assert.equal(digest(readFileSync(bundlePath)), identity.bundleHash)
for (const [name, expectedHash] of Object.entries(identity.measurementScriptHashes)) {
  assert.equal(
    digest(readFileSync(new URL(name, import.meta.url))),
    expectedHash,
    `Measurement script changed: ${name}`
  )
}
const module = await import(pathToFileURL(bundlePath).href)
const runtime = {
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  bun: false
}
const emit = (record) => process.stdout.write(`${JSON.stringify(record)}\n`)
const timers = new Set()
const delay = (ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      resolve(performance.now())
    }, ms)
    timers.add(timer)
  })
const boundaries = []
const memory = (label) => {
  const value = process.memoryUsage()
  boundaries.push({ label, ...value })
  return value
}
const gc = () => {
  assert.equal(typeof globalThis.gc, 'function')
  void /probe/.test('probe')
  globalThis.gc()
  globalThis.gc()
}

async function measure(operation, tiny = false, control = false) {
  const histogram = monitorEventLoopDelay({ resolution: 1 })
  try {
    histogram.enable()
    await delay(5)
    await delay(5)
    histogram.reset()
    await delay(5)
    assert(histogram.count > 0, 'Monitor has no real post-reset samples')
    const samplesBeforeWork = histogram.count
    const before = memory('before-timed-work')
    const utilizationBefore = performance.eventLoopUtilization()
    const cpuBefore = process.cpuUsage()
    const armed = performance.now()
    const primary = delay(5)
    const started = performance.now()
    let output
    let calls = 0
    do {
      output = operation()
      calls++
    } while (tiny && performance.now() - started < 30)
    const wallMs = performance.now() - started
    const cpu = process.cpuUsage(cpuBefore)
    const utilization = performance.eventLoopUtilization(utilizationBefore)
    const after = memory('after-timed-work')
    const fired = await primary
    const postWorkCount = histogram.count
    await delay(5)
    assert(histogram.count > postWorkCount, 'Monitor has no post-work sampling tick')
    const histogramMaxMs = histogram.max / 1e6
    const timerLatenessMs = Math.max(0, fired - armed - 5)
    for (const key of ['active', 'idle', 'utilization']) {
      assert(Number.isFinite(utilization[key]) && utilization[key] >= 0)
    }
    assert(utilization.active > 0 && utilization.utilization <= 1)
    if (control) {
      assert(timerLatenessMs >= 30)
      assert(histogramMaxMs >= 30)
    }
    return {
      output,
      sample: {
        calls,
        wallMs,
        cpu,
        utilization,
        timerLatenessMs,
        histogramMaxMs,
        samplesBeforeWork,
        postWorkCount,
        finalCount: histogram.count,
        before,
        after
      }
    }
  } finally {
    assert(histogram.disable())
    assert(!histogram.disable())
    for (const timer of timers) {
      clearTimeout(timer)
    }
    timers.clear()
  }
}

let inputIdentity
function ready(input = '') {
  inputIdentity = {
    inputBytes: Buffer.byteLength(input),
    codeUnits: input.length,
    inputHash: digest(input)
  }
  emit({
    type: 'ready',
    identity,
    runtime,
    ...inputIdentity
  })
}
function result(fields) {
  const maxima = (field) => Math.max(0, ...boundaries.map((item) => item[field]))
  emit({
    type: 'result',
    id: descriptor.id,
    mode: descriptor.mode,
    arm: descriptor.arm,
    family: descriptor.family,
    width: descriptor.width,
    bytes: descriptor.bytes,
    inputIdentity,
    variant: descriptor.variant,
    ...fields,
    processLifetimeMaxRssKiB: process.resourceUsage().maxRSS,
    maxObservedBoundaryHeapUsedBytes: maxima('heapUsed'),
    maxObservedBoundaryExternalBytes: maxima('external'),
    maxObservedBoundaryArrayBuffersBytes: maxima('arrayBuffers'),
    boundaries
  })
}

function assertSafe(output) {
  assert(Buffer.byteLength(output) <= LIMIT, 'Excerpt exceeded 16 KiB')
  assert(!module.TERMINAL_CONTROL_CHARACTER_PATTERN.test(output), 'Unsafe excerpt controls')
  assert(!output.includes('\r'), 'Unnormalized CR')
}
function legacySanitize(value) {
  return module.ownRetainedString(
    module
      .stripAnsiEscapeSequences(value)
      .replace(/\r\n?/g, '\n')
      .replace(module.TERMINAL_CONTROL_CHARACTER_PATTERN, '')
  )
}

function retained() {
  if (descriptor.arm === 'no-buffer') {
    globalThis.Buffer = undefined
    module.resetOwnRetainedStringCopier()
  }
  const byteLength = new TextEncoder()
  const size = descriptor.family === 'near-cap' ? 63 * 1024 * 1024 : 2 * 1024 * 1024
  const count = descriptor.count ?? 8
  for (let index = 0; index < 3; index++) {
    module.ownRetainedString('warm owned string '.repeat(1000))
  }
  gc()
  const before = memory('warmed-retention-baseline')
  let excerpts = []
  let encodedTotal = 0
  for (let index = 0; index < count; index++) {
    const unit =
      descriptor.family === 'cache'
        ? ['plain ', '界😀', '\x9dunfinished ', '\ud800a\udfff'][index % 4]
        : 'x'
    const chunk = unit.repeat(1024)
    let parent = [
      `${index}:`,
      ...Array.from({ length: Math.ceil(size / chunk.length) }, () => chunk)
    ].join('')
    // The flat parent is distinct for each retained result; source references die each iteration.
    const output =
      descriptor.arm === 'pinned'
        ? parent.slice(-LIMIT)
        : descriptor.arm === 'baseline'
          ? module.sliceCheckLogTail(parent)
          : module.sanitizeCheckJobLogExcerpt(parent)
    const bytes = byteLength.encode(output).length
    assert(bytes <= LIMIT)
    encodedTotal += bytes
    excerpts.push(output)
    parent = ''
  }
  gc()
  const retainedMemory = memory('retained-excerpts-after-double-gc')
  assert(encodedTotal <= 2 * 1024 * 1024)
  const retainedCount = excerpts.length
  excerpts = []
  gc()
  const released = memory('released-excerpts-after-double-gc')
  const delta = (value) =>
    Object.fromEntries(
      ['heapUsed', 'external', 'arrayBuffers', 'rss'].map((field) => [
        field,
        value[field] - before[field]
      ])
    )
  const growth = delta(retainedMemory)
  const release = delta(released)
  if (descriptor.family !== 'near-cap') {
    assert(release.heapUsed < 4 * 1024 * 1024, 'Excerpts did not release near the warmed heap')
  }
  result({ retainedCount, encodedTotal, growth, release, samples: [] })
}

try {
  if (descriptor.mode === 'retention') {
    ready()
    retained()
  } else if (descriptor.mode === 'watchdog') {
    ready()
    emit({ type: 'entered', phase: 'watchdog' })
    while (true) {}
  } else if (descriptor.mode === 'control') {
    ready()
    memory('after-setup')
    if (descriptor.family === 'cleanup') {
      const monitor = monitorEventLoopDelay({ resolution: 1 })
      try {
        monitor.enable()
        void delay(1000)
        throw new Error('cleanup-sentinel')
      } catch (error) {
        assert.equal(error.message, 'cleanup-sentinel')
      } finally {
        assert(monitor.disable())
        assert(!monitor.disable())
        for (const timer of timers) {
          clearTimeout(timer)
        }
        timers.clear()
      }
      result({ samples: [], cleaned: true })
    } else {
      const measured = await measure(
        () => {
          const start = performance.now()
          while (performance.now() - start < 50) {}
          return ''
        },
        false,
        true
      )
      result({ samples: [measured.sample] })
    }
  } else if (descriptor.mode === 'differential') {
    ready()
    let cases = 0
    const outputs = createHash('sha256')
    memory('before-differential')
    for (const input of plainLogDifferentialCases()) {
      const output = module.sliceCheckLogTail(input)
      assert(Buffer.byteLength(output) <= LIMIT)
      outputs.update(JSON.stringify(output))
      cases++
    }
    memory('after-differential')
    result({ samples: [], cases, outputHash: outputs.digest('hex') })
  } else {
    const generated = workload(descriptor)
    let input = generated.text
    let expected = generated.expected
    const expectedHash = expected === undefined ? undefined : digest(expected)
    expected = undefined
    generated.expected = undefined
    generated.text = undefined
    ready(input)
    memory('after-setup')
    if (descriptor.mode === 'coverage') {
      module.resetObservations()
      const output = module.sliceCheckLogTail(input)
      if (descriptor.arm === 'proposed') {
        assertSafe(output)
      } else {
        assert(Buffer.byteLength(output) <= LIMIT)
      }
      const observations = module.observations()
      if (descriptor.arm === 'proposed') {
        assert((observations.strip?.maxBytes ?? 0) <= LIMIT)
        assert(
          (observations.candidate?.maxBytes ?? 0) <= (descriptor.bytes > LIMIT ? LIMIT / 2 : LIMIT)
        )
        assert(
          (observations.matcher?.maxBytes ?? 0) <= (descriptor.bytes > LIMIT ? LIMIT / 2 : LIMIT)
        )
        assert((observations.exact?.maxBytes ?? 0) <= LIMIT)
      }
      memory('after-coverage')
      result({
        samples: [],
        observations,
        outputBytes: Buffer.byteLength(output),
        outputHash: digest(output)
      })
    } else if (descriptor.mode === 'counts') {
      const original = String.prototype.charCodeAt
      let reads = 0
      const originalBuffer = globalThis.Buffer
      if (descriptor.noBuffer) {
        globalThis.Buffer = undefined
        module.resetOwnRetainedStringCopier()
      }
      try {
        String.prototype.charCodeAt = function (index) {
          reads++
          return original.call(this, index)
        }
        const output = module.stripAnsiEscapeSequences(input)
        globalThis.Buffer = originalBuffer
        assert.equal(digest(output), expectedHash)
      } finally {
        globalThis.Buffer = originalBuffer
        module.resetOwnRetainedStringCopier()
        String.prototype.charCodeAt = original
      }
      assert(reads >= 0 && reads <= 12 * input.length + 64)
      if (
        ['osc', 'dcs', 'apc', 'pm', 'sos', 'dense-osc', 'dense-string', 'mixed', 'sparse'].includes(
          descriptor.family
        )
      ) {
        assert(reads > 0)
      }
      result({ samples: [], reads, codeUnits: input.length })
    } else {
      const operation =
        descriptor.mode === 'direct'
          ? () => module.stripAnsiEscapeSequences(input)
          : descriptor.arm === 'full-log'
            ? () => module.sliceCheckLogTail(legacySanitize(input))
            : descriptor.arm === 'baseline-bounded'
              ? () => legacySanitize(module.sliceCheckLogTail(input))
              : () => module.sliceCheckLogTail(input)
      const warmups = descriptor.warmups ?? 3
      memory('before-warmup')
      for (let warmup = 0; warmup < warmups; warmup++) {
        module.setPhase('warmup')
        emit({ type: 'entered', phase: 'warmup', warmup })
        operation()
      }
      memory('after-warmup')
      gc()
      const samples = []
      let outputBytes = 0
      let outputHash = ''
      let diagnosticRetained = false
      let stackRetained = false
      for (let sample = 0; sample < descriptor.samples; sample++) {
        module.setPhase('sample')
        emit({ type: 'entered', phase: 'sample', sample })
        const measured = await measure(
          operation,
          descriptor.mode === 'direct' && descriptor.bytes <= 32 * 1024
        )
        if (expectedHash) {
          assert.equal(digest(measured.output), expectedHash, 'Direct output changed')
        }
        if (descriptor.mode === 'cpu') {
          assert(Buffer.byteLength(measured.output) <= LIMIT)
          if (descriptor.arm !== 'baseline') {
            assertSafe(measured.output)
          }
          const plain =
            descriptor.arm === 'baseline' ? legacySanitize(measured.output) : measured.output
          diagnosticRetained = plain.includes(
            descriptor.family === 'short-lines'
              ? 'error: CPU_DIAGNOSTIC'
              : descriptor.family === 'fixture'
                ? createCheckLogFixture().expectedDiagnostic
                : 'No "Copy" export is defined on the "lucide-react" mock'
          )
          stackRetained = plain.includes(
            descriptor.family === 'short-lines'
              ? 'CPU_FRAME.ts:18:8'
              : descriptor.family === 'fixture'
                ? createCheckLogFixture().expectedStackFrame
                : 'CopyTabIdMenuItem.tsx:18:8'
          )
          assert(diagnosticRetained && stackRetained)
        }
        outputBytes = Buffer.byteLength(measured.output)
        outputHash = digest(measured.output)
        samples.push(measured.sample)
      }
      result({ samples, outputBytes, outputHash, diagnosticRetained, stackRetained })
    }
    input = ''
  }
  assert.equal(timers.size, 0)
  assert.equal(process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length, 0)
} finally {
  for (const timer of timers) {
    clearTimeout(timer)
  }
  timers.clear()
}
