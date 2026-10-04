import { expect, it } from 'vitest'
import { entryStaticClosure } from './build-mobile-web-app-bundle.mjs'

it.each([1, 12, 128, 1000])(
  'keeps the complete %s-output closure without shifting a second queue',
  (count) => {
    const paths = Array.from({ length: count }, (_value, index) => `dist/chunk-${index}.js`)
    const metafile = {
      outputs: Object.fromEntries(
        paths.map((path, index) => [
          path,
          {
            bytes: index + 1,
            imports:
              index === 0
                ? paths.slice(1).map((child) => ({ kind: 'import-statement', path: child }))
                : []
          }
        ])
      )
    }
    const before = structuredClone(metafile)
    const originalShift = Array.prototype.shift
    let reached
    let shifts = 0
    Array.prototype.shift = function () {
      shifts++
      return originalShift.call(this)
    }
    try {
      reached = entryStaticClosure(metafile, paths[0])
    } finally {
      Array.prototype.shift = originalShift
    }
    expect([...reached]).toEqual(paths)
    expect(metafile).toEqual(before)
    expect([...reached].reduce((total, path) => total + metafile.outputs[path].bytes, 0)).toBe(
      (count * (count + 1)) / 2
    )
    const fresh = entryStaticClosure(metafile, paths[0])
    expect(fresh).not.toBe(reached)
    reached.add('mutated-result')
    expect([...fresh]).toEqual(paths)
    expect(shifts).toBe(0)
  }
)

it('keeps breadth-first order, duplicates, cycles, missing chunks and dynamic boundaries', () => {
  const metafile = {
    outputs: {
      entry: {
        imports: [
          { kind: 'import-statement', path: 'one' },
          { kind: 'dynamic-import', path: 'deferred' },
          { kind: 'import-statement', path: 'two' },
          { kind: 'import-statement', path: 'one' }
        ]
      },
      one: { imports: [{ kind: 'import-statement', path: 'three' }] },
      two: {
        imports: [
          { kind: 'import-statement', path: 'entry' },
          { kind: 'import-statement', path: 'three' },
          { kind: 'import-statement', path: 'missing' }
        ]
      },
      three: { imports: [] },
      deferred: { imports: [{ kind: 'import-statement', path: 'deferred-child' }] }
    }
  }
  expect([...entryStaticClosure(metafile, 'entry')]).toEqual([
    'entry',
    'one',
    'two',
    'three',
    'missing'
  ])
  metafile.outputs.one.imports.push({ kind: 'import-statement', path: 'fresh-😀' })
  expect([...entryStaticClosure(metafile, 'entry')]).toEqual([
    'entry',
    'one',
    'two',
    'three',
    'fresh-😀',
    'missing'
  ])
  expect([...entryStaticClosure({ outputs: {} }, 'unknown')]).toEqual(['unknown'])
})

it('keeps a later output error after earlier discoveries in the same order', () => {
  const error = new Error('later-output')
  const reads = []
  const outputs = {
    get entry() {
      reads.push('entry')
      return {
        imports: [
          { kind: 'import-statement', path: 'one' },
          { kind: 'import-statement', path: 'two' }
        ]
      }
    },
    get one() {
      reads.push('one')
      return { imports: [{ kind: 'import-statement', path: 'three' }] }
    },
    get two() {
      reads.push('two')
      throw error
    }
  }
  let caught
  try {
    entryStaticClosure({ outputs }, 'entry')
  } catch (failure) {
    caught = failure
  }
  expect(caught).toBe(error)
  expect(reads).toEqual(['entry', 'one', 'two'])
})
