import { expect, it } from 'vitest'
import { entryStaticClosure } from './build-mobile-web-app-bundle.mjs'

it('returns every reachable chunk in a fresh set without changing the metadata', () => {
  const paths = Array.from({ length: 128 }, (_value, index) => `dist/chunk-${index}.js`)
  const metafile = {
    outputs: Object.fromEntries(
      paths.map((path, index) => [
        path,
        {
          imports:
            index === 0
              ? paths.slice(1).map((child) => ({ kind: 'import-statement', path: child }))
              : []
        }
      ])
    )
  }
  const before = structuredClone(metafile)
  const reached = entryStaticClosure(metafile, paths[0])
  expect(reached).toEqual(new Set(paths))
  expect(metafile).toEqual(before)
  const fresh = entryStaticClosure(metafile, paths[0])
  expect(fresh).not.toBe(reached)
  reached.add('mutated-result')
  expect(fresh).toEqual(new Set(paths))
})

it('follows static imports through duplicates, cycles and missing chunks without loading dynamic imports', () => {
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
  expect(entryStaticClosure(metafile, 'entry')).toEqual(
    new Set(['entry', 'one', 'two', 'three', 'missing'])
  )
  metafile.outputs.one.imports.push({ kind: 'import-statement', path: 'fresh-😀' })
  expect(entryStaticClosure(metafile, 'entry')).toEqual(
    new Set(['entry', 'one', 'two', 'three', 'fresh-😀', 'missing'])
  )
  expect(entryStaticClosure({ outputs: {} }, 'unknown')).toEqual(new Set(['unknown']))
})
