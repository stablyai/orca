#!/usr/bin/env node
// Compares legacy, slice-run, and production-adaptive control stripping.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import nodeModule from 'node:module'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

if (!process.execArgv.includes('--experimental-transform-types')) {
  const result = spawnSync(
    process.execPath,
    ['--experimental-transform-types', '--no-warnings', import.meta.filename],
    { stdio: 'inherit' }
  )
  process.exit(result.status ?? 1)
}

nodeModule.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier) && context.parentURL) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL)
      if (existsSync(fileURLToPath(candidate))) {
        return { url: candidate.href, shortCircuit: true }
      }
    }
    return nextResolve(specifier, context)
  }
})

const PRODUCTION_SOURCE = readFileSync(
  new URL('../../src/shared/terminal-control-stripping.ts', import.meta.url),
  'utf8'
)
for (const marker of [
  'export function stripTerminalControl(data: string): string',
  'strippedInBlock === CONTROL_DENSITY_FALLBACK_COUNT',
  'output += withoutAnsi.slice(runStart, index)',
  // Retuning either density constant changes which fixtures sit above/below the trigger, so
  // pin the literals rather than the names: a silent retune would leave the sub-threshold
  // fixture measuring a boundary that no longer exists.
  'const CONTROL_DENSITY_BLOCK_CODE_UNITS = 64',
  'const CONTROL_DENSITY_FALLBACK_COUNT = 32'
]) {
  if (!PRODUCTION_SOURCE.includes(marker)) {
    throw new Error(`terminal-control-stripping.ts no longer contains \`${marker}\``)
  }
}

const { stripTerminalControl: stripAdaptive } = await import(
  new URL('../../src/shared/terminal-control-stripping.ts', import.meta.url).href
)

const ESC = String.fromCharCode(0x1b)
const BEL = String.fromCharCode(0x07)
const ANSI_ESCAPE_RE = new RegExp(
  `${ESC}(?:[@-Z\\\\-_]|\\[[0-?]*[ -/]*[@-~]|\\][^${BEL}]*(?:${BEL}|${ESC}\\\\))`,
  'g'
)
const INCOMPLETE_ANSI_ESCAPE_RE = new RegExp(
  `${ESC}(?:\\[[0-?]*[ -/]*|\\][^${BEL}${ESC}]*|\\S?)?$`,
  'g'
)
const HISTORY_LIMIT = 300
const SCAN_LIMIT = 4096
const SAMPLE_ID_LENGTH = 24
// Mirrors terminal-control-stripping.ts; the marker guard above fails if either is retuned.
const CONTROL_DENSITY_BLOCK_CODE_UNITS = 64
const CONTROL_DENSITY_FALLBACK_COUNT = 32
const ITERATIONS = Number(process.env.ORCA_STRIP_BENCH_ITERATIONS ?? '501')
let resultChecksum = 0
let validatedPairs = 0

if (!Number.isSafeInteger(ITERATIONS) || ITERATIONS <= 0) {
  throw new Error(`ORCA_STRIP_BENCH_ITERATIONS must be a positive integer, got ${ITERATIONS}`)
}

function isStrippedCode(code) {
  return (code <= 0x1f && code !== 0x0a && code !== 0x0d) || (code >= 0x7f && code <= 0x9f)
}

function terminalControlMayAffectText(data) {
  for (let index = 0; index < data.length; index += 1) {
    const code = data.charCodeAt(index)
    if (
      code === 0x0d ||
      code === 0x1b ||
      (code <= 0x1f && code !== 0x0a) ||
      (code >= 0x7f && code <= 0x9f)
    ) {
      return true
    }
  }
  return false
}

function stripPerChar(data) {
  if (!terminalControlMayAffectText(data)) {
    return data
  }
  const withoutAnsi = data.replace(ANSI_ESCAPE_RE, '').replace(INCOMPLETE_ANSI_ESCAPE_RE, '')
  let output = ''
  for (let index = 0; index < withoutAnsi.length; index += 1) {
    if (isStrippedCode(withoutAnsi.charCodeAt(index))) {
      continue
    }
    output += withoutAnsi[index]
  }
  return output
}

function stripSliceRuns(data) {
  if (!terminalControlMayAffectText(data)) {
    return data
  }
  const withoutAnsi = data.replace(ANSI_ESCAPE_RE, '').replace(INCOMPLETE_ANSI_ESCAPE_RE, '')
  let output = ''
  let runStart = 0
  for (let index = 0; index < withoutAnsi.length; index += 1) {
    if (isStrippedCode(withoutAnsi.charCodeAt(index))) {
      if (index > runStart) {
        output += withoutAnsi.slice(runStart, index)
      }
      runStart = index + 1
    }
  }
  return runStart === 0 ? withoutAnsi : output + withoutAnsi.slice(runStart)
}

function adaptiveFallbackIndex(data) {
  const withoutAnsi = data.replace(ANSI_ESCAPE_RE, '').replace(INCOMPLETE_ANSI_ESCAPE_RE, '')
  let strippedInBlock = 0
  let blockEnd = 64
  for (let index = 0; index < withoutAnsi.length; index += 1) {
    if (index === blockEnd) {
      strippedInBlock = 0
      blockEnd += 64
    }
    if (isStrippedCode(withoutAnsi.charCodeAt(index))) {
      strippedInBlock += 1
      if (strippedInBlock === 32) {
        return index
      }
    }
  }
  return -1
}

function fixedSampleId(sampleId) {
  return `sample:${sampleId}`.padEnd(SAMPLE_ID_LENGTH, '_').slice(0, SAMPLE_ID_LENGTH)
}

function makeTuiFixture(length, sampleId, strippedControl) {
  const lines = [
    `${strippedControl}\x1b[35m✻ Thinking...\x1b[0m\r\n`,
    '  ⏺ Running tests... 42 passed, 0 failed\r\n'
  ]
  let text = `${fixedSampleId(sampleId)}\r\n`
  for (let lineIndex = 0; ; lineIndex += 1) {
    const next = lines[lineIndex % lines.length]
    if (text.length + next.length > length) {
      break
    }
    text += next
  }
  return text + 'x'.repeat(length - text.length)
}

// 31 controls per 64-unit block: one below the fallback trigger, so the adaptive path keeps
// slice-run bookkeeping on a shape dense enough to lose to the per-character legacy. This is the
// worst surviving case; it exists so the narrowed adverse window stays visible instead of hiding
// behind the 50% fixture, where the fallback fires and wins.
function makeSubThresholdDenseFixture(length, sampleId, strippedControl) {
  const id = fixedSampleId(sampleId)
  const units = []
  for (let index = 0; index < length; index += 1) {
    const blockOffset = index % CONTROL_DENSITY_BLOCK_CODE_UNITS
    if (index < id.length) {
      units.push(id[index])
    } else if (blockOffset % 2 === 1 && blockOffset < (CONTROL_DENSITY_FALLBACK_COUNT - 1) * 2) {
      units.push(strippedControl)
    } else {
      units.push(String.fromCharCode(97 + (index % 26)))
    }
  }
  return units.join('')
}

function makeDenseFixture(length, sampleId, strippedControl) {
  const prefix = `\x1b[35m${fixedSampleId(sampleId)}`
  const suffix = '\x1b[0m'
  const bodyLength = length - prefix.length - suffix.length
  const body = `x${strippedControl}`.repeat(Math.floor(bodyLength / 2))
  return `${prefix}${body}${bodyLength % 2 === 0 ? '' : 'x'}${suffix}`
}

function median(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

function measure(strip, fixture) {
  const start = performance.now()
  const output = strip(fixture)
  return { elapsed: performance.now() - start, output }
}

function consumeOutput(output) {
  resultChecksum = Math.imul(resultChecksum ^ output.length, 16777619) >>> 0
  resultChecksum ^= output.charCodeAt(Math.floor(output.length / 2))
}

const IMPLEMENTATIONS = [
  ['perChar', stripPerChar, '\x01'],
  ['sliceRuns', stripSliceRuns, '\x02'],
  ['adaptive', stripAdaptive, '\x03']
]

function recordRotation(fixture, sampleId, lead, samples) {
  const inputs = IMPLEMENTATIONS.map(([name, strip, control]) => ({
    name,
    strip,
    input: fixture.make(sampleId, control)
  }))
  if (inputs.some(({ input }) => input.length !== fixture.length)) {
    throw new Error(`invalid inputs for ${fixture.label}, sample ${sampleId}`)
  }
  const results = new Map()
  for (let offset = 0; offset < inputs.length; offset += 1) {
    const entry = inputs[(lead + offset) % inputs.length]
    results.set(entry.name, measure(entry.strip, entry.input))
  }
  const outputs = [...results.values()].map(({ output }) => output)
  if (new Set(outputs).size !== 1) {
    throw new Error(`strip mismatch for ${fixture.label}, sample ${sampleId}`)
  }
  for (const [name, result] of results) {
    consumeOutput(result.output)
    samples[name].push(result.elapsed)
  }
  validatedPairs += 1
}

const denseBodyLength = SCAN_LIMIT - '\x1b[35m'.length - SAMPLE_ID_LENGTH - '\x1b[0m'.length
const denseControlPercent = ((Math.floor(denseBodyLength / 2) / SCAN_LIMIT) * 100).toFixed(1)
const fixtures = [
  {
    label: `${HISTORY_LIMIT} history TUI`,
    length: HISTORY_LIMIT,
    make: (sampleId, control) => makeTuiFixture(HISTORY_LIMIT, sampleId, control)
  },
  {
    label: `${HISTORY_LIMIT + 1} boundary TUI`,
    length: HISTORY_LIMIT + 1,
    make: (sampleId, control) => makeTuiFixture(HISTORY_LIMIT + 1, sampleId, control)
  },
  {
    label: `${SCAN_LIMIT} scan TUI`,
    length: SCAN_LIMIT,
    make: (sampleId, control) => makeTuiFixture(SCAN_LIMIT, sampleId, control)
  },
  {
    label: `${SCAN_LIMIT} scan ${denseControlPercent}% C0`,
    length: SCAN_LIMIT,
    make: (sampleId, control) => makeDenseFixture(SCAN_LIMIT, sampleId, control)
  },
  {
    label: `${SCAN_LIMIT} scan 31/block C0`,
    length: SCAN_LIMIT,
    make: (sampleId, control) => makeSubThresholdDenseFixture(SCAN_LIMIT, sampleId, control)
  }
]

const selectorFixtures = [
  { label: '31 controls', data: `${'\x01'.repeat(31)}${'a'.repeat(33)}`, expected: -1 },
  { label: '32 controls', data: `${'\x01'.repeat(32)}${'a'.repeat(32)}`, expected: 31 },
  {
    label: 'block reset at 64',
    data: `${'\x01'.repeat(31)}${'a'.repeat(33)}${'\x01'.repeat(32)}`,
    expected: 95
  },
  {
    label: 'late dense block',
    data: `${'a'.repeat(64 * 3)}${'\x01'.repeat(32)}tail`,
    expected: 223
  },
  {
    label: 'routine TUI',
    data: makeTuiFixture(SCAN_LIMIT, 'selector', '\x01'),
    expected: -1
  },
  {
    label: '31/block never triggers',
    data: makeSubThresholdDenseFixture(SCAN_LIMIT, 'selector', '\x01'),
    expected: -1
  }
]
for (const fixture of selectorFixtures) {
  const actual = adaptiveFallbackIndex(fixture.data)
  if (actual !== fixture.expected) {
    throw new Error(`${fixture.label} fallback index ${actual}, expected ${fixture.expected}`)
  }
}

const pad = (value, width) => String(value).padStart(width)
console.log('Complete stripTerminalControl path. Lower is better.')
console.log(`iterations=${ITERATIONS} (${ITERATIONS * 3} rotated samples/implementation, median)`)
console.log(
  `${pad('fixture', 25)} ${pad('per-char', 11)} ${pad('slice runs', 12)} ${pad('adaptive', 11)} ${pad('vs legacy', 10)} ${pad('vs slice', 9)}`
)

for (const fixture of fixtures) {
  const samples = { perChar: [], sliceRuns: [], adaptive: [] }
  for (let index = 0; index < ITERATIONS; index += 1) {
    for (let lead = 0; lead < IMPLEMENTATIONS.length; lead += 1) {
      recordRotation(fixture, `${index}:lead-${lead}`, lead, samples)
    }
  }
  const perChar = median(samples.perChar)
  const sliceRuns = median(samples.sliceRuns)
  const adaptive = median(samples.adaptive)
  console.log(
    `${pad(fixture.label, 25)} ${pad(`${(perChar * 1000).toFixed(1)} us`, 11)} ${pad(`${(sliceRuns * 1000).toFixed(1)} us`, 12)} ${pad(`${(adaptive * 1000).toFixed(1)} us`, 11)} ${pad(`${(perChar / adaptive).toFixed(2)}x`, 10)} ${pad(`${(sliceRuns / adaptive).toFixed(2)}x`, 9)}`
  )
}
console.log(
  `\nvalidated=${validatedPairs} measured rotations, result checksum=${resultChecksum >>> 0}`
)
console.log(`selector checks=${selectorFixtures.length}`)
console.log('Production calls are bounded to 4096, 4096, 300, and 301 code units.')
