import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { collectUnitDependencyGraph } from './ci-unit-dependency-graph.mjs'
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
