import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectUnitDependencyGraph } from './ci-unit-dependency-graph.mjs'
import { selectUnitFiles } from '../ci-unit-selection.mjs'

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

describe('unit graph import resolution', () => {
  it('keeps extensionless consumers when a covered JavaScript sibling changes', () => {
    const graph = collectUnitDependencyGraph(
      fixture({
        'src/value.ts': 'export const value = 1',
        'src/value.js': 'export const value = 2',
        'src/extensionless.test.ts': "import { value } from './value'",
        'src/explicit.test.ts': "import { value } from './value.js'"
      })
    )
    const tests = ['src/extensionless.test.ts', 'src/explicit.test.ts', 'src/unrelated.test.ts']
    expect(selectUnitFiles(tests, ['src/value.js'], graph)).toMatchObject({
      full: false,
      files: ['src/extensionless.test.ts', 'src/explicit.test.ts']
    })
  })

  it.each([
    ['js', 'ts'],
    ['js', 'tsx'],
    ['jsx', 'tsx'],
    ['mjs', 'mts'],
    ['cjs', 'cts']
  ])('retains TypeScript substitutions for .%s imports through .%s', (output, source) => {
    const graph = collectUnitDependencyGraph(
      fixture({
        [`src/value.${source}`]: 'export const value = 1',
        [`src/value.${output}.ts`]: 'export const value = 2',
        'src/substitution.test.ts': `import { value } from './value.${output}'`,
        'src/explicit.test.ts': `import { value } from './value.${source}'`
      })
    )
    const tests = ['src/substitution.test.ts', 'src/explicit.test.ts', 'src/unrelated.test.ts']
    expect(selectUnitFiles(tests, [`src/value.${source}`], graph)).toMatchObject({
      full: false,
      files: ['src/substitution.test.ts', 'src/explicit.test.ts']
    })
  })

  it('retains directory consumers whose manifest can override an index file', () => {
    const graph = collectUnitDependencyGraph(
      fixture({
        'src/folder/package.json': JSON.stringify({ main: './entry.js' }),
        'src/folder/index.ts': 'export const value = 1',
        'src/folder/entry.js': "export { value } from '../selected-input'",
        'src/selected-input.ts': 'export const value = 2',
        'src/directory.test.ts': "import { value } from './folder'",
        'src/explicit.test.ts': "import { value } from './selected-input'"
      })
    )
    const tests = ['src/directory.test.ts', 'src/explicit.test.ts', 'src/unrelated.test.ts']
    expect(selectUnitFiles(tests, ['src/selected-input.ts'], graph)).toMatchObject({
      full: false,
      files: ['src/directory.test.ts', 'src/explicit.test.ts']
    })
  })
})
