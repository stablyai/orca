import { describe, expect, it } from 'vitest'
import { diffBaselines, parseFailures } from './windows-suite-baseline.mjs'

const ANSI = '[31m'
const RESET = '[0m'

describe('parseFailures', () => {
  it('counts one entry per failing test, keyed by file', () => {
    const log = [
      ' FAIL  src/a.test.ts > suite > first',
      ' FAIL  src/a.test.ts > suite > second',
      ' FAIL  src/b.test.ts > other > only'
    ].join('\n')

    expect(parseFailures(log)).toEqual({ 'src/a.test.ts': 2, 'src/b.test.ts': 1 })
  })

  it('sees through the colour codes vitest writes to a tty', () => {
    const log = ` ${ANSI}FAIL${RESET}  src/a.test.ts > suite > first`

    expect(parseFailures(log)).toEqual({ 'src/a.test.ts': 1 })
  })

  it('drops the line/column suffix so a moved test does not read as a new file', () => {
    const log = ' FAIL  src/a.test.ts:12:3 > suite > first'

    expect(parseFailures(log)).toEqual({ 'src/a.test.ts': 1 })
  })

  it('counts a suite that failed to collect, which has no test name', () => {
    const log = ' FAIL  config/scripts/x.test.mjs [ config/scripts/x.test.mjs ]'

    expect(parseFailures(log)).toEqual({ 'config/scripts/x.test.mjs': 1 })
  })

  it('returns nothing for a clean run', () => {
    expect(parseFailures('Test Files  10 passed (10)\n')).toEqual({})
  })

  it('ignores the word FAIL when it is not a vitest result line', () => {
    const log = 'stderr | some test\nthe request returned FAIL  src/nope.test.ts\n'

    expect(parseFailures(log)).toEqual({})
  })
})

describe('diffBaselines', () => {
  it('reports nothing when the run matches the baseline', () => {
    const both = { 'src/a.test.ts': 2 }

    expect(diffBaselines(both, both)).toEqual({
      newlyFailing: [],
      worse: [],
      better: [],
      fixed: [],
      regressed: false
    })
  })

  it('flags a file that was not failing before', () => {
    const diff = diffBaselines({ 'src/a.test.ts': 2 }, { 'src/a.test.ts': 2, 'src/b.test.ts': 1 })

    expect(diff.newlyFailing).toEqual([{ file: 'src/b.test.ts', before: 0, after: 1 }])
    expect(diff.regressed).toBe(true)
  })

  it('flags a file that got worse', () => {
    const diff = diffBaselines({ 'src/a.test.ts': 2 }, { 'src/a.test.ts': 5 })

    expect(diff.worse).toEqual([{ file: 'src/a.test.ts', before: 2, after: 5 }])
    expect(diff.regressed).toBe(true)
  })

  it('does not treat progress as a regression', () => {
    const diff = diffBaselines({ 'src/a.test.ts': 5, 'src/b.test.ts': 1 }, { 'src/a.test.ts': 2 })

    expect(diff.better).toEqual([{ file: 'src/a.test.ts', before: 5, after: 2 }])
    expect(diff.fixed).toEqual([{ file: 'src/b.test.ts', before: 1, after: 0 }])
    expect(diff.regressed).toBe(false)
  })

  it('reports progress and regression together rather than hiding one', () => {
    // A phase that fixes its own cluster while breaking another must not read
    // as a win; the exit code has to come from the regression alone.
    const diff = diffBaselines({ 'src/a.test.ts': 5 }, { 'src/a.test.ts': 1, 'src/c.test.ts': 3 })

    expect(diff.better).toEqual([{ file: 'src/a.test.ts', before: 5, after: 1 }])
    expect(diff.newlyFailing).toEqual([{ file: 'src/c.test.ts', before: 0, after: 3 }])
    expect(diff.regressed).toBe(true)
  })

  it('orders each list by file so the report is stable across runs', () => {
    const diff = diffBaselines({}, { 'src/z.test.ts': 1, 'src/a.test.ts': 1 })

    expect(diff.newlyFailing.map((entry) => entry.file)).toEqual(['src/a.test.ts', 'src/z.test.ts'])
  })
})
