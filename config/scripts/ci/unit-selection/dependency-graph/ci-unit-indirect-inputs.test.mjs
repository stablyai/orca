import { expect, it } from 'vitest'
import { buildUnitDependencyGraph } from './ci-unit-dependency-graph.mjs'
import { selectUnitFiles } from '../ci-unit-selection.mjs'

function selected(source) {
  const sources = new Map([
    ['src/changed.ts', 'export const value = 1'],
    ['src/changed.test.ts', "import './changed'"],
    ['src/indirect.ts', source],
    ['src/indirect.test.ts', "import './indirect'"]
  ])
  const graph = buildUnitDependencyGraph(sources)
  return selectUnitFiles(['src/changed.test.ts', 'src/indirect.test.ts'], ['src/changed.ts'], {
    ...graph,
    files: new Set(sources.keys())
  }).files
}

it('does not retain unrelated consumers of names in comments and strings', () => {
  expect(selected("// spawn readFileSync\nexport const prose = 'glob'")).toEqual([
    'src/changed.test.ts'
  ])
})

it.each([
  "import { readFileSync as read } from 'node:fs'; export const value = read(path)",
  'import(computedModule)',
  'spawn( @@@'
])('retains consumers with indirect inputs or invalid syntax: %s', (source) => {
  expect(selected(source)).toEqual(['src/changed.test.ts', 'src/indirect.test.ts'])
})
