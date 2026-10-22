import { expect, it } from 'vitest'
import { buildUnitDependencyGraph } from './ci-unit-dependency-graph.mjs'
import { selectUnitFiles } from './ci-unit-selection.mjs'

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

it.each([
  '// spawn a process, readFileSync, glob, new URL(path)',
  'export const value = globalThis.value ?? global.value',
  "export const prose = 'spawn readFileSync glob'",
  'export interface Config { spawnToken: string; Worker: string }',
  'export type Config = { readFile: string; global: boolean }',
  "export const url = new URL('https://example.test/data')",
  'export const spawnToken = "opaque-token"'
])('does not retain unrelated tests for syntax that loads no repository inputs: %s', (source) => {
  expect(selected(source)).toEqual(['src/changed.test.ts'])
})

it.each([
  "import { readFileSync as read } from 'node:fs'; export const value = read(path)",
  "import * as fs from 'node:fs'; export const value = fs['read' + 'FileSync'](path)",
  "import { spawn as launch } from 'node:child_process'; launch(binary)",
  "import { glob as find } from 'tinyglobby'; find(pattern)",
  "import * as vm from 'node:vm'; vm['run' + 'InNewContext'](code)",
  "import * as hostModule from 'node:module'; export const loader = hostModule['create' + 'Require'](path)",
  "const file = new URL('./fixture.txt', import.meta.url)",
  'const url = new URL(runtimeValue)',
  'import(computedModule)',
  'require(computedModule)',
  "const read = fs['readFileSync']; read(path)",
  'const execute = runProcess; execute(command)',
  'const load = process.getBuiltinModule; load(moduleName)',
  'eval(source)',
  'const execute = new Function(source); execute()',
  'spawn( @@@'
])(
  'retains indirect consumers even for aliases, computed access and invalid syntax: %s',
  (source) => {
    expect(selected(source)).toEqual(['src/changed.test.ts', 'src/indirect.test.ts'])
  }
)

it('retains type-import ownership edges independently of runtime opacity', () => {
  const graph = buildUnitDependencyGraph(
    new Map([
      ['src/types.ts', 'export interface Worker { id: string }'],
      ['src/consumer.ts', "import type { Worker } from './types'"],
      ['src/value.json', '{"global":true}']
    ])
  )
  expect([...graph.reverse.get('src/types.ts')]).toEqual(['src/consumer.ts'])
  expect(graph.opaque.size).toBe(0)
})
