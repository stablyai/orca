#!/usr/bin/env node
// Benchmarks the production terminal byte-measurement exports at their real budgets: the output
// batcher push and the snapshot budget scan. Every scenario asserts whether production invoked
// Buffer.byteLength, so implementation drift cannot preserve stale speedup claims.
import { spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import fs from 'node:fs'
import nodeModule from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

if (!process.execArgv.includes('--experimental-transform-types')) {
  const result = spawnSync(
    process.execPath,
    ['--experimental-transform-types', '--no-warnings', import.meta.filename],
    { stdio: 'inherit' }
  )
  process.exit(result.status ?? 1)
}

// The app's TS sources import siblings without an extension; Node's ESM resolver needs it.
nodeModule.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier) && context.parentURL) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL)
      if (fs.existsSync(fileURLToPath(candidate))) {
        return { url: candidate.href, shortCircuit: true }
      }
    }
    return nextResolve(specifier, context)
  }
})

const ROOT = path.resolve(import.meta.dirname, '../..')
const ITERATIONS = Number(process.env.ORCA_BYTE_LENGTH_BENCH_ITERATIONS ?? '61')
let resultChecksum = 0
let validatedPairs = 0

if (!Number.isSafeInteger(ITERATIONS) || ITERATIONS <= 0) {
  throw new Error(`ORCA_BYTE_LENGTH_BENCH_ITERATIONS must be a positive integer, got ${ITERATIONS}`)
}

function readSource(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8')
}

const TERMINAL_SOURCE = readSource('src/main/runtime/rpc/methods/terminal.ts')

function requireCallForm(source, needle, label) {
  if (!source.includes(needle)) {
    throw new Error(`${label} is stale: expected call form \`${needle}\` was not found`)
  }
}

const { TERMINAL_OUTPUT_BATCH_MAX_BYTES, TERMINAL_STREAM_CHUNK_BYTES } = await import(
  new URL('../../src/shared/terminal-multiplex-flow-control.ts', import.meta.url).href
)
const { measureClipboardTextByteLength } = await import(
  new URL('../../src/shared/clipboard-text.ts', import.meta.url).href
)
const {
  MIN_NATIVE_BYTE_LENGTH_CODE_UNITS,
  measureTerminalStreamByteLength,
  terminalStreamByteLengthExceeds
} = await import(
  new URL('../../src/main/runtime/rpc/terminal-stream-byte-length.ts', import.meta.url).href
)

const REQUESTED_SNAPSHOT_BYTE_BUDGET = (() => {
  const match = /const REQUESTED_SNAPSHOT_BYTE_BUDGET = ([^\n]+)/.exec(TERMINAL_SOURCE)
  if (!match) {
    throw new Error('terminal.ts is stale: REQUESTED_SNAPSHOT_BYTE_BUDGET is gone')
  }
  return Number(new Function(`return (${match[1].trim()})`)())
})()

requireCallForm(TERMINAL_SOURCE, 'measureTerminalStreamByteLength(data, {', 'terminal.ts')
requireCallForm(TERMINAL_SOURCE, 'stopAfterBytes: remainingBudget', 'terminal.ts')
requireCallForm(
  TERMINAL_SOURCE,
  'terminalStreamByteLengthExceeds(data, REQUESTED_SNAPSHOT_BYTE_BUDGET)',
  'terminal.ts'
)

const nativeByteLength = Buffer.byteLength
function runWithNativeCallCount(fn) {
  let calls = 0
  Buffer.byteLength = (...args) => {
    calls += 1
    return Reflect.apply(nativeByteLength, Buffer, args)
  }
  try {
    return { output: fn(), calls }
  } finally {
    Buffer.byteLength = nativeByteLength
  }
}

// ---- OLD ARM: the production implementation terminal.ts called before this change.
const legacyMeasure = measureClipboardTextByteLength
const legacyExceeds = (data, maxBytes) =>
  measureClipboardTextByteLength(data, { stopAfterBytes: maxBytes }).exceededLimit

// ---- Fixtures. Deterministic, seeded, and varied per sample so V8 cannot hoist.
function mulberry32(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Realistic agent-TUI output: mostly ASCII with SGR runs, box drawing, and emoji status
// glyphs, plus a per-sample marker so no two measured strings are identical.
function makeTerminalText(codeUnits, sampleId) {
  const random = mulberry32(sampleId * 2654435761)
  const lines = [
    '[35m✻ Thinking…[0m\r\n',
    '  ⏺ Running tests… 42 passed, 0 failed\r\n',
    '│ src/main/runtime/rpc/methods/terminal.ts  │\r\n',
    '  ✅ build succeeded in 12.4s — café naïve\r\n',
    '[32m+ added line[0m\r\n'
  ]
  let text = `sample:${sampleId}\r\n`
  while (text.length < codeUnits) {
    text += lines[Math.floor(random() * lines.length)]
  }
  return text.slice(0, codeUnits)
}

// Keystroke echo and tiny interactive writes: the shapes a PTY emits between key presses.
function makeInteractiveText(codeUnits, sampleId) {
  const random = mulberry32(sampleId * 40503)
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789 ./-_'
  let text = ''
  while (text.length < codeUnits) {
    text += alphabet[Math.floor(random() * alphabet.length)]
  }
  return text.slice(0, codeUnits)
}

// Trim to just under a BYTE budget so the legacy arm runs its full scan without tripping the limit.
function makeTerminalTextUnderBytes(byteBudget, sampleId) {
  let text = makeTerminalText(byteBudget, sampleId)
  while (Buffer.byteLength(text, 'utf8') > byteBudget) {
    text = text.slice(0, Math.floor(text.length * (byteBudget / Buffer.byteLength(text, 'utf8'))))
  }
  return text
}

// The TRUE adversary for the exceeds gate: stay at the code-unit cap so `length > maxBytes`
// cannot short-circuit, but pack 3-byte BMP scalars so the legacy scan bails out after only a
// THIRD of the string while Buffer.byteLength still walks all of it.
function makeEarlyTripText(byteBudget, sampleId) {
  const tripUnits = Math.ceil((byteBudget + 1) / 3)
  const marker = String.fromCharCode(0x4e00 + (sampleId % 4096))
  const prefix = `${marker}${'走'.repeat(tripUnits - 1)}`
  return `${prefix}${'a'.repeat(byteBudget - tripUnits)}`
}

function median(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

function consume(value) {
  resultChecksum = Math.imul(resultChecksum ^ (value | 0), 16777619) >>> 0
}

// Small inputs are far below timer resolution, so batch them: build `repeats` distinct
// samples, time the whole loop, and report per-call cost. Consuming the running total
// inside the timed region keeps V8 from hoisting the calls out.
function runScenario(scenario) {
  const repeats = scenario.repeats ?? 1
  const samples = { legacy: [], next: [] }
  const runArm = (fn, inputs) => {
    const start = performance.now()
    let total = 0
    for (const input of inputs) {
      total += scenario.checksum(fn(input))
    }
    const elapsed = performance.now() - start
    return { elapsed, total }
  }
  for (let index = 0; index < ITERATIONS; index += 1) {
    // Alternate which arm leads on every iteration so cache/JIT warmup is shared evenly.
    for (const legacyFirst of index % 2 === 0 ? [true, false] : [false, true]) {
      const batch = index * 2 + (legacyFirst ? 0 : 1)
      const inputs = []
      for (let repeat = 0; repeat < repeats; repeat += 1) {
        inputs.push(scenario.make(batch * repeats + repeat))
      }
      const legacyOutputs = inputs.map(scenario.legacy)
      const observed = runWithNativeCallCount(() => inputs.map(scenario.next))
      for (let inputIndex = 0; inputIndex < inputs.length; inputIndex += 1) {
        const input = inputs[inputIndex]
        const legacyOutput = legacyOutputs[inputIndex]
        const nextOutput = observed.output[inputIndex]
        if (!scenario.equal(legacyOutput, nextOutput)) {
          throw new Error(
            `${scenario.label}: arms disagree on ${JSON.stringify(input.slice(0, 40))}`
          )
        }
        scenario.assertResult(legacyOutput, input)
        validatedPairs += 1
      }
      scenario.assertNativeCalls(inputs.length, observed.calls)
      let legacyResult
      let nextResult
      if (legacyFirst) {
        legacyResult = runArm(scenario.legacy, inputs)
        nextResult = runArm(scenario.next, inputs)
      } else {
        nextResult = runArm(scenario.next, inputs)
        legacyResult = runArm(scenario.legacy, inputs)
      }
      consume(legacyResult.total)
      consume(nextResult.total)
      samples.legacy.push(legacyResult.elapsed / repeats)
      samples.next.push(nextResult.elapsed / repeats)
    }
  }
  return { legacy: median(samples.legacy), next: median(samples.next) }
}

const measurementEqual = (a, b) =>
  a.byteLength === b.byteLength && a.exceededLimit === b.exceededLimit
const measurementChecksum = (m) => m.byteLength + (m.exceededLimit ? 1 : 0)
const booleanChecksum = (value) => (value ? 1 : 0)

// Every scenario states which production branch it expects. Native fixtures require exactly one
// Buffer.byteLength call per input; fallback fixtures require none.
function requireBranch(expected) {
  return (inputCount, calls) => {
    const expectedCalls = expected === 'nativeFastPath' ? inputCount : 0
    if (calls !== expectedCalls) {
      throw new Error(
        `expected the production ${expected} branch (${expectedCalls} Buffer.byteLength calls), got ${calls}`
      )
    }
  }
}

const batchScenario = (label, make, options = {}) => ({
  label,
  make,
  repeats: options.repeats,
  legacy: (input) => legacyMeasure(input, { stopAfterBytes: TERMINAL_OUTPUT_BATCH_MAX_BYTES }),
  next: (input) =>
    measureTerminalStreamByteLength(input, {
      stopAfterBytes: TERMINAL_OUTPUT_BATCH_MAX_BYTES
    }),
  equal: measurementEqual,
  checksum: measurementChecksum,
  assertResult: (out, input) => options.assert?.(out, input),
  assertNativeCalls: requireBranch(options.branch)
})

const gateScenario = (label, budget, make, options = {}) => ({
  label,
  make,
  repeats: options.repeats,
  legacy: (input) => legacyExceeds(input, budget),
  next: (input) => terminalStreamByteLengthExceeds(input, budget),
  equal: (a, b) => a === b,
  checksum: booleanChecksum,
  assertResult: (out, input) => options.assert?.(out, input),
  assertNativeCalls: requireBranch(options.branch)
})

const scenarios = [
  batchScenario('batcher push 8KiB', (sampleId) => makeTerminalText(8 * 1024, sampleId), {
    branch: 'nativeFastPath',
    assert: (out) => {
      if (out.exceededLimit) {
        throw new Error('batcher push 8KiB should stay under the batch budget')
      }
    }
  }),
  batchScenario(
    'batcher push over budget',
    // Oversized on purpose: this is the case where the arms MUST both return the partial count.
    (sampleId) => makeTerminalText(3 * TERMINAL_OUTPUT_BATCH_MAX_BYTES, sampleId),
    {
      branch: 'scanFallback',
      assert: (out) => {
        if (!out.exceededLimit) {
          throw new Error('over-budget fixture never exceeded the limit')
        }
      }
    }
  ),
  // TRUE WORST CASE for the batcher push. The guard only takes the native count when
  // length*3 <= stopAfterBytes, which PROVES the limit cannot trip, so the fast path can never
  // pay for both a Buffer.byteLength and a scan. What is left is the shape where the native
  // call replaces the fewest scan iterations: a chunk sitting just above the code-unit floor.
  batchScenario(
    `batcher push ${MIN_NATIVE_BYTE_LENGTH_CODE_UNITS}B (floor)`,
    (sampleId) => makeInteractiveText(MIN_NATIVE_BYTE_LENGTH_CODE_UNITS, sampleId),
    { branch: 'nativeFastPath', repeats: 4096 }
  ),
  // Below the floor the new arm deliberately keeps the scan, so it is the legacy code exactly.
  batchScenario('batcher push 4B keystroke', (sampleId) => makeInteractiveText(4, sampleId), {
    branch: 'scanFallback',
    repeats: 4096
  }),
  gateScenario(
    `snapshot scan ${(REQUESTED_SNAPSHOT_BYTE_BUDGET / (1024 * 1024)).toFixed(0)}MiB`,
    REQUESTED_SNAPSHOT_BYTE_BUDGET,
    (sampleId) => makeTerminalTextUnderBytes(REQUESTED_SNAPSHOT_BYTE_BUDGET, sampleId),
    {
      branch: 'nativeFastPath',
      assert: (out) => {
        if (out) {
          throw new Error('snapshot fixture should sit under the budget so the full scan runs')
        }
      }
    }
  ),
  // TRUE WORST CASE for the boolean gate: at the code-unit cap so `length > maxBytes` cannot
  // short-circuit, but 3-byte scalars let the legacy scan bail out a THIRD of the way in while
  // Buffer.byteLength still walks the whole string. This is where the new arm can actually lose.
  gateScenario(
    'snapshot gate early-trip',
    REQUESTED_SNAPSHOT_BYTE_BUDGET,
    (sampleId) => makeEarlyTripText(REQUESTED_SNAPSHOT_BYTE_BUDGET, sampleId),
    {
      branch: 'nativeFastPath',
      assert: (out, input) => {
        if (!out) {
          throw new Error('early-trip gate fixture must exceed the budget')
        }
        if (input.length > REQUESTED_SNAPSHOT_BYTE_BUDGET) {
          throw new Error('early-trip fixture must not hit the code-unit short circuit')
        }
      }
    }
  ),
  gateScenario(
    'chunk gate early-trip',
    TERMINAL_STREAM_CHUNK_BYTES,
    (sampleId) => makeEarlyTripText(TERMINAL_STREAM_CHUNK_BYTES, sampleId),
    {
      branch: 'nativeFastPath',
      assert: (out, input) => {
        if (!out) {
          throw new Error('early-trip chunk fixture must exceed the budget')
        }
        if (input.length > TERMINAL_STREAM_CHUNK_BYTES) {
          throw new Error('early-trip fixture must not hit the code-unit short circuit')
        }
      }
    }
  ),
  gateScenario(
    `chunk gate ${TERMINAL_STREAM_CHUNK_BYTES / 1024}KiB`,
    TERMINAL_STREAM_CHUNK_BYTES,
    (sampleId) => makeTerminalTextUnderBytes(TERMINAL_STREAM_CHUNK_BYTES, sampleId),
    {
      branch: 'nativeFastPath',
      assert: (out) => {
        if (out) {
          throw new Error('chunk gate fixture should sit under the chunk budget')
        }
      }
    }
  )
]

const pad = (value, width) => String(value).padStart(width)
const formatTime = (ms) =>
  ms >= 0.001 ? `${(ms * 1000).toFixed(1)} us` : `${(ms * 1e6).toFixed(1)} ns`
console.log('Production terminal byte-measurement paths. Lower is better.')
console.log(
  `iterations=${ITERATIONS} (${ITERATIONS * 2} counterbalanced batches/scenario, per-arm medians)`
)
console.log(`${pad('scenario', 30)} ${pad('legacy', 12)} ${pad('new', 12)} ${pad('speedup', 9)}`)
for (const scenario of scenarios) {
  const { legacy, next } = runScenario(scenario)
  console.log(
    `${pad(scenario.label, 30)} ${pad(formatTime(legacy), 12)} ${pad(formatTime(next), 12)} ${pad(`${(legacy / next).toFixed(2)}x`, 9)}`
  )
}

// Small-chunk sweep across real interactive PTY write sizes. The floor makes everything below
// MIN_NATIVE_BYTE_LENGTH_CODE_UNITS byte-identical to the legacy scan, so those rows must land
// at ~1.00x; anything materially below that is a regression the change would be shipping.
{
  console.log(
    `\nbatcher push small-chunk sweep (stopAfterBytes=${TERMINAL_OUTPUT_BATCH_MAX_BYTES}):`
  )
  console.log(
    `${pad('bytes', 10)} ${pad('legacy', 12)} ${pad('new', 12)} ${pad('speedup', 9)}  branch`
  )
  for (const codeUnits of [4, 8, 16, 64, 256, 1024, 4096]) {
    const expectedBranch =
      codeUnits >= MIN_NATIVE_BYTE_LENGTH_CODE_UNITS ? 'nativeFastPath' : 'scanFallback'
    const { legacy, next } = runScenario(
      batchScenario(`sweep ${codeUnits}`, (sampleId) => makeInteractiveText(codeUnits, sampleId), {
        branch: expectedBranch,
        repeats: Math.max(64, Math.min(4096, Math.ceil(2 ** 18 / codeUnits)))
      })
    )
    const branch = expectedBranch === 'nativeFastPath' ? 'native' : 'scan (unchanged)'
    console.log(
      `${pad(`${codeUnits} B`, 10)} ${pad(formatTime(legacy), 12)} ${pad(formatTime(next), 12)} ${pad(`${(legacy / next).toFixed(2)}x`, 9)}  ${branch}`
    )
  }
}

console.log(`\nvalidated=${validatedPairs} measured pairs, result checksum=${resultChecksum >>> 0}`)
