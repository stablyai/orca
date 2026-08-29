#!/usr/bin/env node
// Benchmarks optioned localeCompare calls used by renderer list comparators.
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'

const ROUND_COUNT = 5
const MIN_ROUND_MS = 120
const jiti = createJiti(import.meta.url, {
  alias: { '@': fileURLToPath(new URL('../../src/renderer/src', import.meta.url)) }
})
const { compareBaseSensitivityLocaleText } = await jiti.import(
  '../../src/renderer/src/lib/locale-text-collators.ts'
)
const { sortJiraIssues } = await jiti.import(
  '../../src/renderer/src/components/jira-issue-sorter.ts'
)

let randomState = 0x9e3779b9
function random() {
  randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0
  return randomState / 0x100000000
}

function shuffle(values) {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1))
    ;[values[index], values[swapIndex]] = [values[swapIndex], values[index]]
  }
  return values
}

const labels = ['alpha', 'Álpha', 'beta', 'BÉTA', 'café', 'Cafe', 'zeta', 'Ångström']

function makeJiraIssues(count) {
  return shuffle(
    Array.from({ length: count }, (_, index) => ({
      key: `TASK-${(index * 37) % (count + 17)}`,
      title: labels[index % labels.length],
      updatedAt: '2026-01-01T00:00:00.000Z'
    }))
  )
}

function makeBaseSensitivityValues(count) {
  return shuffle(
    Array.from(
      { length: count },
      (_, index) =>
        `${labels[(index * 5) % labels.length]}-${String((index * 41) % (count + 23)).padStart(4, '0')}`
    )
  )
}

function calibrate(run) {
  for (let index = 0; index < 5; index += 1) {
    run()
  }
  let iterations = 1
  while (true) {
    const startedAt = performance.now()
    for (let index = 0; index < iterations; index += 1) {
      run()
    }
    if (performance.now() - startedAt >= MIN_ROUND_MS) {
      break
    }
    iterations *= 2
  }
  return iterations
}

function measureRound(run, iterations) {
  const startedAt = performance.now()
  for (let index = 0; index < iterations; index += 1) {
    run()
  }
  return (performance.now() - startedAt) / iterations
}

function measurePair(before, after) {
  const beforeIterations = calibrate(before)
  const afterIterations = calibrate(after)
  const beforeSamples = []
  const afterSamples = []
  for (let round = 0; round < ROUND_COUNT; round += 1) {
    if (round % 2 === 0) {
      beforeSamples.push(measureRound(before, beforeIterations))
      afterSamples.push(measureRound(after, afterIterations))
    } else {
      afterSamples.push(measureRound(after, afterIterations))
      beforeSamples.push(measureRound(before, beforeIterations))
    }
  }
  const middle = Math.floor(ROUND_COUNT / 2)
  return {
    beforeMs: beforeSamples.sort((a, b) => a - b)[middle],
    afterMs: afterSamples.sort((a, b) => a - b)[middle]
  }
}

function assertSameOrder(before, after, label) {
  const expected = before()
  const actual = after()
  if (
    expected.length !== actual.length ||
    expected.some((value, index) => value !== actual[index])
  ) {
    throw new Error(`${label} sort order changed`)
  }
}

const pad = (value, width) => String(value).padStart(width)
console.log('Renderer locale sort, ms per sort (median of 5 rounds). Lower is better.')
console.log(
  `${pad('mode', 9)} ${pad('items', 7)} ${pad('per-call', 11)} ${pad('reused', 11)} ${pad('speedup', 9)}`
)

for (const count of [36, 50, 250]) {
  const issues = makeJiraIssues(count)
  const before = () =>
    [...issues]
      .sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }))
      .map((issue) => issue.key)
  const after = () => sortJiraIssues(issues, 'key', 'asc').map((issue) => issue.key)
  assertSameOrder(before, after, `numeric ${count}`)
  const { beforeMs, afterMs } = measurePair(before, after)
  console.log(
    `${pad('numeric', 9)} ${pad(count, 7)} ${pad(`${beforeMs.toFixed(3)} ms`, 11)} ${pad(`${afterMs.toFixed(3)} ms`, 11)} ${pad(`${(beforeMs / afterMs).toFixed(1)}x`, 9)}`
  )
}

for (const count of [10, 50, 250]) {
  const values = makeBaseSensitivityValues(count)
  const before = () =>
    [...values].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
  const after = () => [...values].sort(compareBaseSensitivityLocaleText)
  assertSameOrder(before, after, `base ${count}`)
  const { beforeMs, afterMs } = measurePair(before, after)
  console.log(
    `${pad('base', 9)} ${pad(count, 7)} ${pad(`${beforeMs.toFixed(3)} ms`, 11)} ${pad(`${afterMs.toFixed(3)} ms`, 11)} ${pad(`${(beforeMs / afterMs).toFixed(1)}x`, 9)}`
  )
}

console.log(
  '\n36 rows matches the Linear page size, 50 matches the picker/Jira scale, and\n250 is a stress case. Both arms assert identical output before timing.'
)
