#!/usr/bin/env node
// Mirrors the complete pre/post stripTerminalControl paths at their production size caps.
import { performance } from 'node:perf_hooks'

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

function recordPair(fixture, sampleId, perCharFirst, samples) {
  const perCharFixture = fixture.make(sampleId, perCharFirst ? '\x01' : '\x02')
  const sliceRunsFixture = fixture.make(sampleId, perCharFirst ? '\x02' : '\x01')
  if (
    perCharFixture === sliceRunsFixture ||
    perCharFixture.length !== fixture.length ||
    sliceRunsFixture.length !== fixture.length
  ) {
    throw new Error(`invalid inputs for ${fixture.label}, sample ${sampleId}`)
  }
  let perCharResult
  let sliceRunsResult
  if (perCharFirst) {
    perCharResult = measure(stripPerChar, perCharFixture)
    sliceRunsResult = measure(stripSliceRuns, sliceRunsFixture)
  } else {
    sliceRunsResult = measure(stripSliceRuns, sliceRunsFixture)
    perCharResult = measure(stripPerChar, perCharFixture)
  }
  if (perCharResult.output !== sliceRunsResult.output) {
    throw new Error(`strip mismatch for ${fixture.label}, sample ${sampleId}`)
  }
  consumeOutput(perCharResult.output)
  consumeOutput(sliceRunsResult.output)
  validatedPairs += 1
  samples.perChar.push(perCharResult.elapsed)
  samples.sliceRuns.push(sliceRunsResult.elapsed)
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
  }
]

const pad = (value, width) => String(value).padStart(width)
console.log('Complete stripTerminalControl path. Lower is better.')
console.log(
  `iterations=${ITERATIONS} (${ITERATIONS * 2} first-touch samples/implementation, counterbalanced median)`
)
console.log(
  `${pad('fixture', 25)} ${pad('per-char', 11)} ${pad('slice runs', 12)} ${pad('speedup', 9)}`
)

for (const fixture of fixtures) {
  const samples = { perChar: [], sliceRuns: [] }
  for (let index = 0; index < ITERATIONS; index += 1) {
    const orders = index % 2 === 0 ? [true, false] : [false, true]
    for (const perCharFirst of orders) {
      const orderLabel = perCharFirst ? 'per-first' : 'slice-first'
      recordPair(fixture, `${index}:${orderLabel}`, perCharFirst, samples)
    }
  }
  const perChar = median(samples.perChar)
  const sliceRuns = median(samples.sliceRuns)
  console.log(
    `${pad(fixture.label, 25)} ${pad(`${(perChar * 1000).toFixed(1)} us`, 11)} ${pad(`${(sliceRuns * 1000).toFixed(1)} us`, 12)} ${pad(`${(perChar / sliceRuns).toFixed(2)}x`, 9)}`
  )
}
console.log(`\nvalidated=${validatedPairs} measured pairs, result checksum=${resultChecksum >>> 0}`)
console.log('Production calls are bounded to 4096, 4096, 300, and 301 code units.')
