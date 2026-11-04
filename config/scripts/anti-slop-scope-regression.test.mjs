import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { runOxlintPluginOnSources } from './oxlint-plugin-test-runner.mjs'

const directory = mkdtempSync(path.join(import.meta.dirname, '.anti-slop-scope-'))
const source = path.dirname(createRequire(import.meta.url).resolve('oxlint-plugin-anti-slop'))
cpSync(source, directory, { recursive: true })
afterAll(() => rmSync(directory, { recursive: true, force: true }))

function lint(sources, rule) {
  return runOxlintPluginOnSources({
    pluginName: 'anti-slop',
    pluginPath: path.join(directory, 'index.ts'),
    rules: { [`anti-slop/${rule}`]: 'error' },
    sources,
    extension: 'ts'
  })
}

const wideningCases = [
  ['const value = {}; const wide: unknown = value; wide as { id: string };', 1],
  ['const value = {}; const alias = value; const wide: unknown = alias; <{ id: string }>wide;', 1],
  ['function parse(input: unknown) { return input as { id: string }; }', 0],
  ['const value = {}; let wide: unknown = value; wide as { id: string };', 0],
  ['const value = {}; const wide: unknown = value; function read() { return wide as {}; }', 0],
  [
    'const value = {}; const wide: unknown = value; function read(wide: unknown) { return wide as {}; }',
    0
  ],
  ['const value = {}; const wide: unknown = value; wide as unknown;', 0]
]

const mockCases = [
  ["import { vi as test } from 'vitest'; test.mock('module');", 1],
  ["import { jest as test } from '@jest/globals'; test['doMock']('module');", 1],
  ["jest.unstable_mockModule('module', () => ({}));", 1],
  ["vi['mock']('module');", 1],
  ["import { vi } from 'vitest'; vi.mocked(value);", 0],
  ["const unrelated = { mock() {} }; unrelated.mock('module');", 0],
  ["const vi = { mock() {} }; vi.mock('module');", 0],
  ["import { vi as test } from 'vitest'; function run(test) { test.mock('module'); }", 0]
]

const wideningDiagnostics = new Map()
const mockDiagnostics = new Map()
beforeAll(() => {
  for (const [cases, rule, results] of [
    [wideningCases, 'no-widen-then-assert', wideningDiagnostics],
    [mockCases, 'no-module-mocking', mockDiagnostics]
  ]) {
    const sources = cases.map(([source]) => source)
    lint(sources, rule).forEach((diagnostics, index) => results.set(sources[index], diagnostics))
  }
})

it.each(wideningCases)(
  'preserves widening evidence and lexical boundaries: %s',
  (source, count) => {
    expect(wideningDiagnostics.get(source)).toHaveLength(count)
  }
)

it.each(mockCases)('preserves mock method and owner resolution: %s', (source, count) => {
  expect(mockDiagnostics.get(source)).toHaveLength(count)
})
