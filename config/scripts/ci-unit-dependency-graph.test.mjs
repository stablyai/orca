import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildUnitDependencyGraph,
  collectUnitDependencyGraph
} from './ci-unit-dependency-graph.mjs'
import { selectUnitFiles } from './ci-unit-selection.mjs'

const temporary = []
afterEach(() => {
  for (const root of temporary.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function fixture(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'unit-workspace-graph-'))
  temporary.push(root)
  const manifest = (name, source) =>
    JSON.stringify({
      name,
      exports: {
        '.': { 'orca-source': source, types: './dist/index.d.ts', default: './dist/index.js' }
      }
    })
  const files = {
    'pnpm-workspace.yaml': 'packages:\n  - src/packages/*\n',
    'src/packages/process-host/package.json': manifest(
      '@orca/process-host',
      './src/run-process.ts'
    ),
    'src/packages/process-host/src/run-process.ts':
      "import { value } from '@orca/byte-buffer'; export { value }; throw Error('source must not execute')",
    'src/packages/process-host/dist/index.js': 'throw Error("stale output")',
    'src/packages/byte-buffer/package.json': manifest('@orca/byte-buffer', './src/byte-buffer.ts'),
    'src/packages/byte-buffer/src/byte-buffer.ts': 'export const value = 1',
    'src/consumer.test.ts': "import '@orca/process-host'",
    'src/dynamic.test.ts': "import('@orca/process-host')",
    'src/require.test.ts': "require('@orca/process-host')",
    'src/type.test.ts': "import type { value } from '@orca/process-host'",
    'src/unrelated.test.ts': 'export const unrelated = true',
    ...extra
  }
  for (const [file, source] of Object.entries(files)) {
    const path = join(root, file)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, source)
  }
  return root
}

it('tracks transitive public workspace source consumers including type and dynamic imports', () => {
  const graph = collectUnitDependencyGraph(fixture())
  const tests = [...graph.files].filter((file) => file.endsWith('.test.ts')).sort()
  expect(
    selectUnitFiles(tests, ['src/packages/byte-buffer/src/byte-buffer.ts'], graph)
  ).toMatchObject({
    full: false,
    files: [
      'src/consumer.test.ts',
      'src/dynamic.test.ts',
      'src/require.test.ts',
      'src/type.test.ts'
    ]
  })
  expect(graph.files.has('src/packages/process-host/dist/index.js')).toBe(false)
})

it('tracks package manifests as inputs to all public consumers', () => {
  const graph = collectUnitDependencyGraph(fixture())
  const tests = [...graph.files].filter((file) => file.endsWith('.test.ts')).sort()
  for (const manifest of [
    'src/packages/process-host/package.json',
    'src/packages/byte-buffer/package.json'
  ]) {
    const selection = selectUnitFiles(tests, [manifest], graph)
    expect(selection.full).toBe(false)
    expect(selection.files).toEqual(tests.filter((file) => file !== 'src/unrelated.test.ts'))
  }
})

it.each(['@orca/unknown', '@orca/process-host/private'])(
  'does not silently drop unresolved internal imports: %s',
  (specifier) => {
    expect(() =>
      collectUnitDependencyGraph(fixture({ 'src/consumer.test.ts': `import '${specifier}'` }))
    ).toThrow('No public orca-source export')
  }
)

it.each([
  [
    'an assigned native loader',
    'src/main/windows-native-registry.ts',
    "import { createRequire } from 'node:module'; const requireFromMain = createRequire(__filename); export const loadWindowsNativeRegistry = () => requireFromMain('@orca/windows-registry')",
    'src/main/windows-registry-addon.test.ts',
    "import { loadWindowsNativeRegistry } from './windows-native-registry'"
  ],
  [
    'a direct loader with a runtime serializer path',
    'src/main/daemon/serialize-grid-roundtrip.ts',
    "import { createRequire } from 'node:module'; export const loadOldSerializer = (path) => createRequire(import.meta.url)(path)",
    'src/main/daemon/serialize-grid.differential.fuzz.test.ts',
    "import { loadOldSerializer } from './serialize-grid-roundtrip'"
  ],
  [
    'a module namespace whose computed loader escapes through an object',
    'src/main/stored-native-loader.ts',
    "import * as hostModule from 'node:module'; const native = hostModule; const load = native['create' + 'Require'](__filename); const api = { load }; export const open = (path) => api.load(path)",
    'src/main/stored-native-loader.test.ts',
    "import { open } from './stored-native-loader'"
  ],
  [
    'an optional builtin loader',
    'src/main/sqlite/sync-database.ts',
    "export const isSqliteAvailable = () => process.getBuiltinModule?.('node:sqlite')",
    'src/main/sqlite/sync-database-portability.test.ts',
    "import { isSqliteAvailable } from './sync-database'"
  ],
  [
    'an assigned builtin loader',
    'src/main/sqlite/assigned-reader.ts',
    "const getBuiltin = process.getBuiltinModule; export const sqlite = () => getBuiltin('node:sqlite')",
    'src/main/sqlite/assigned-reader.test.ts',
    "import { sqlite } from './assigned-reader'"
  ]
])(
  'keeps real test consumers of %s when another covered source changes',
  (_label, owner, source, consumer, testSource) => {
    const graph = collectUnitDependencyGraph(
      fixture({
        [owner]: source,
        [consumer]: testSource,
        'src/selected-input.ts': 'export const value = 1',
        'src/selected-input.test.ts': "import { value } from './selected-input'"
      })
    )
    const tests = [...graph.files].filter((file) => file.endsWith('.test.ts')).sort()
    expect(selectUnitFiles(tests, ['src/selected-input.ts'], graph)).toMatchObject({
      full: false,
      files: [consumer, 'src/selected-input.test.ts'].sort()
    })
  }
)

describe('unit graph import resolution', () => {
  it('keeps first-match precedence across literal paths, extensions and index files', () => {
    const sources = new Map([
      ['src/leaf', ''],
      ['src/leaf.ts', ''],
      ['src/leaf.tsx', ''],
      ['src/component.tsx', ''],
      ['src/component.js', ''],
      ['src/folder/index.ts', ''],
      ['src/folder/index.tsx', ''],
      ['src/config.json', '{}'],
      ['src/renderer/src/view.tsx', ''],
      ['src/use.ts', "import './leaf'; import './component'; import './folder'; import './config'"],
      ['src/aliases.ts', "import '@renderer/view'; import '@/view'; import 'external-package'"],
      ['src/missing.ts', "import './missing-file'"],
      ['src/dynamic.ts', 'import(variablePath)'],
      ['config/owner.mjs', "import '../src/leaf'"],
      ['tests/owner.ts', "import '../src/leaf'"]
    ])
    expect(buildUnitDependencyGraph(sources)).toEqual({
      reverse: new Map([
        ['src/leaf', new Set(['src/use.ts', 'config/owner.mjs', 'tests/owner.ts'])],
        ['src/component.tsx', new Set(['src/use.ts'])],
        ['src/folder/index.ts', new Set(['src/use.ts'])],
        ['src/config.json', new Set(['src/use.ts'])],
        ['src/renderer/src/view.tsx', new Set(['src/aliases.ts'])]
      ]),
      opaque: new Set(['src/missing.ts', 'src/dynamic.ts', 'config/owner.mjs', 'tests/owner.ts'])
    })
  })
})
