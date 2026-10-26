import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { beforeAll, expect, it } from 'vitest'
import { runOxlintPluginOnSources } from './oxlint-plugin-test-runner.mjs'

const pluginPath = path.resolve('config/oxlint-plugins/anti-slop-prefilter.mjs')

// Each source must still reach its rule through the text prefilter.
const violations = [
  ['no-module-mocking', "import { vi } from 'vitest'; vi.doMock('module');"],
  ['no-object-parameters', 'export function read(value: object): void {}'],
  ['no-reduce-accumulator-copy', 'export const all = [[1]].reduce((acc, x) => acc.concat(x), []);'],
  ['no-reflect-apply', 'export const r = Reflect.apply(Math.max, null, [1]);'],
  ['no-reflect-get', 'export const r = Reflect.get({ a: 1 }, "a");'],
  ['no-shape-in-symbol-names', 'export const rowShape = 1;'],
  ['no-shape-in-symbol-names', 'export const row\\u0053hape = 1;'],
  ['no-unknown-type-aliases', 'export type Payload = unknown;'],
  [
    'no-widen-then-assert',
    'const value = {}; const wide: unknown = value; export const id = wide as { id: string };'
  ]
]

let diagnostics
beforeAll(() => {
  if (!existsSync(path.resolve('.anti-slop-plugin/index.ts'))) {
    execFileSync(process.execPath, ['config/scripts/sync-anti-slop-plugin.mjs'])
  }
  diagnostics = runOxlintPluginOnSources({
    pluginName: 'anti-slop',
    pluginPath,
    rules: Object.fromEntries(violations.map(([rule]) => [`anti-slop/${rule}`, 'error'])),
    sources: violations.map(([, source]) => source),
    extension: 'ts'
  })
})

it.each(violations.map((violation, index) => [...violation, index]))(
  '%s still reports through the prefilter: %s',
  (rule, _source, index) => {
    expect(diagnostics[index].map((diagnostic) => diagnostic.code)).toContain(`anti-slop(${rule})`)
  }
)
