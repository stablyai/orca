import { describe, expect, it } from 'vitest'
import { buildUnitDependencyGraph } from './dependency-graph/ci-unit-dependency-graph.mjs'
import { planUnitSelection, selectUnitFiles } from './ci-unit-selection.mjs'

const sources = new Map(
  Object.entries({
    'src/leaf.ts': 'export const value = 1',
    'src/forward.ts': `export * from './leaf'`,
    'src/consumer.test.ts': `import './forward'`,
    'src/dynamic.test.ts': `import('./leaf')`,
    'src/require.test.ts': `require('./leaf')`,
    'src/scan.test.ts': `import { readFileSync } from 'node:fs'; readFileSync('src/leaf.ts')`,
    'src/indirect.ts': `import(pathFromSettings)`,
    'src/indirect.test.ts': `import './indirect'`,
    'src/unrelated.test.ts': 'export const test = 1',
    'src/renderer/src/view.tsx': 'export const value = 1',
    'src/view.test.ts': `import '@renderer/view'; import '@/view'`
  })
)
const graph = { ...buildUnitDependencyGraph(sources), files: new Set(sources.keys()) }
const files = [...sources.keys()].filter((file) => file.endsWith('.test.ts')).sort()

describe('conservative unit selection', () => {
  it('retains every test for a transitive dependency of the shared runtime', () => {
    const runtime = 'config/vitest.config.ts'
    const sources = new Map([
      ['src/input.ts', 'export const value = 1'],
      ['config/scripts/setup-forward.ts', "export * from '../../src/input'"],
      [
        runtime,
        `import '${runtime === 'config/vitest.config.ts' ? './scripts' : '../..'}/setup-forward'`
      ],
      ['src/direct.test.ts', "import './input'"],
      ['src/unrelated.test.ts', 'export const value = 1']
    ])
    const files = ['src/direct.test.ts', 'src/unrelated.test.ts']
    const graph = { ...buildUnitDependencyGraph(sources), files: new Set(sources.keys()) }
    expect(selectUnitFiles(files, ['src/input.ts'], graph)).toMatchObject({ full: true, files })
    expect(
      planUnitSelection({
        files,
        changed: ['src/input.ts'],
        graph,
        timings: {},
        mode: 'selected',
        event: { pull_request: { draft: true } }
      })
    ).toMatchObject({ mode: 'shadow', executionFiles: files, selectionAvailable: false })
  })

  it('does not mistake a Vitest harness test for a shared runtime entry point', () => {
    const sources = new Map([
      ['src/input.ts', 'export const value = 1'],
      ['config/scripts/vitest-harness.test.mjs', "import '../../src/input'"],
      ['src/direct.test.ts', "import './input'"],
      ['src/unrelated.test.ts', 'export const value = 1']
    ])
    expect(
      selectUnitFiles(['src/direct.test.ts', 'src/unrelated.test.ts'], ['src/input.ts'], {
        ...buildUnitDependencyGraph(sources),
        files: new Set(sources.keys())
      })
    ).toMatchObject({ full: false, files: ['src/direct.test.ts'] })
  })

  it('follows re-exports, literal dynamic imports and requires, retaining indirect readers', () => {
    expect(selectUnitFiles(files, ['src/leaf.ts'], graph).files).toEqual([
      'src/consumer.test.ts',
      'src/dynamic.test.ts',
      'src/indirect.test.ts',
      'src/require.test.ts',
      'src/scan.test.ts'
    ])
  })

  it('does not mistake unrelated opaque readers for coverage of a new entry point', () => {
    const uncovered = { ...graph, files: new Set([...graph.files, 'src/entry.ts']) }
    expect(selectUnitFiles(files, ['src/entry.ts'], uncovered)).toMatchObject({ full: true, files })
  })

  it.each(
    [
      [],
      ['src/deleted.ts'],
      ['src/deleted.ts', 'src/leaf.ts'],
      ['pnpm-lock.yaml'],
      ['config/vitest.config.ts']
    ].map((changed) => ({ changed }))
  )('runs everything for incomplete/global evidence: $changed', ({ changed }) => {
    expect(selectUnitFiles(files, changed, graph)).toMatchObject({ files, full: true })
  })

  it('keeps full coverage by default and on every non-draft commit', () => {
    const base = { files, changed: ['src/leaf.ts'], graph, timings: {} }
    for (const event of [
      {},
      { pull_request: { draft: false } },
      { pull_request: { draft: true } }
    ]) {
      expect(planUnitSelection({ ...base, event }).executionFiles).toEqual(files)
    }
    expect(
      planUnitSelection({ ...base, mode: 'selected', event: { pull_request: { draft: false } } })
        .executionFiles
    ).toEqual(files)
    const selected = planUnitSelection({
      ...base,
      mode: 'selected',
      event: { pull_request: { draft: true } }
    })
    expect(selected.executionFiles).not.toContain('src/unrelated.test.ts')
  })
})
