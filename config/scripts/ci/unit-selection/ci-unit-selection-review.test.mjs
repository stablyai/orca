import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { readUnitSelectionRecords, reviewUnitSelection } from './ci-unit-selection-review.mjs'

const plan = {
  sourceSha: 'sha',
  mode: 'shadow',
  selectionAvailable: true,
  files: ['a', 'b'],
  candidateFiles: ['a']
}

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

it('reviews deferred shadow plans without masking shard plans or accepting another source', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-deferred-selection-'))
  try {
    const fallback = join(root, 'deferred-plan.json')
    writeFileSync(fallback, JSON.stringify(plan))
    for (const [index, file] of ['a', 'b'].entries()) {
      const directory = join(root, String(index))
      mkdirSync(directory)
      writeFileSync(
        join(directory, 'unit-timings.json'),
        JSON.stringify(record(index + 1, file, 'passed').timing)
      )
    }
    const review = () => reviewUnitSelection(readUnitSelectionRecords(root, fallback))[0]
    expect(review()).toMatchObject({ completeFullRun: true, selectionEvaluated: true })
    writeFileSync(fallback, JSON.stringify({ ...plan, sourceSha: 'another-source' }))
    expect(review().completeFullRun).toBe(false)
    for (const index of [0, 1]) {
      writeFileSync(join(root, String(index), 'unit-selection.json'), JSON.stringify(plan))
    }
    expect(review().completeFullRun).toBe(true)
    expect(() => readUnitSelectionRecords(root, join(root, 'missing'))).not.toThrow()
    rmSync(join(root, '0', 'unit-selection.json'))
    expect(() => readUnitSelectionRecords(root, join(root, 'missing'))).toThrow()
  } finally {
    rmSync(root, { recursive: true, force: true })
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
    expect(reviewUnitSelection(rows).map((row) => row.completeFullRun)).toEqual([false])
  }
})
