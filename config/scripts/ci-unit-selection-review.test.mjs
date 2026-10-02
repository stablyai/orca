import { expect, it } from 'vitest'
import { reviewUnitSelection } from './ci-unit-selection-review.mjs'

const plan = {
  sourceSha: 'sha',
  mode: 'shadow',
  selectionAvailable: true,
  files: ['a', 'b'],
  candidateFiles: ['a']
}

it('does not present full fallback runs as selection-validation evidence', () => {
  const records = [record(1, 'a', 'passed'), record(2, 'b', 'passed')].map((row) => ({
    ...row,
    plan: { ...plan, selectionAvailable: false }
  }))
  expect(reviewUnitSelection(records)[0]).toMatchObject({
    completeFullRun: true,
    selectionEvaluated: false
  })
})
const record = (index, file, state) => ({
  plan,
  timing: {
    sourceSha: 'sha',
    runId: '1',
    runAttempt: '1',
    nodeVersion: '24',
    status: state,
    unhandledErrors: 0,
    shard: { index, count: 2 },
    timings: { [file]: 100 },
    results: { [file]: state }
  }
})

it('finds omitted failures in a complete failing reference run', () => {
  expect(
    reviewUnitSelection([record(1, 'a', 'passed'), record(2, 'b', 'failed')])[0]
  ).toMatchObject({ completeFullRun: true, missedFailures: ['b'], potentiallyOmittedWorkerMs: 100 })
})

it('does not call incomplete, duplicate, interrupted or selected evidence a full reference', () => {
  const a = record(1, 'a', 'passed'),
    b = record(2, 'b', 'passed')
  for (const rows of [
    [a],
    [a, a],
    [a, { ...b, timing: { ...b.timing, unhandledErrors: 1 } }],
    [a, { ...b, timing: { ...b.timing, status: 'interrupted' } }],
    [a, b].map((row) => ({ ...row, plan: { ...plan, mode: 'selected' } }))
  ]) {
    expect(reviewUnitSelection(rows).every((row) => !row.completeFullRun)).toBe(true)
  }
})
