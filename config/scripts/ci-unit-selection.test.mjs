import { describe, expect, it } from 'vitest'
import { buildUnitDependencyGraph } from './ci-unit-dependency-graph.mjs'
import {
  FULL_SHARD_COUNT,
  auditUnitSelection,
  planUnitSelection,
  selectUnitFiles
} from './ci-unit-selection.mjs'

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
  it('follows re-exports, literal dynamic imports and requires, retaining indirect readers', () => {
    expect(selectUnitFiles(files, ['src/leaf.ts'], graph).files).toEqual([
      'src/consumer.test.ts',
      'src/dynamic.test.ts',
      'src/indirect.test.ts',
      'src/require.test.ts',
      'src/scan.test.ts'
    ])
  })

  it('resolves renderer aliases and changed tests without executing their source', () => {
    expect(selectUnitFiles(files, ['src/renderer/src/view.tsx'], graph).files).toContain(
      'src/view.test.ts'
    )
    expect(selectUnitFiles(files, ['src/unrelated.test.ts'], graph).files).toContain(
      'src/unrelated.test.ts'
    )
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

  it.each(
    [[], ['pnpm-lock.yaml'], ['config/vitest.config.ts', 'src/leaf.ts']].map((changed) => ({
      changed
    }))
  )('keeps full coverage without reading the graph for global evidence: %j', ({ changed }) => {
    const plan = planUnitSelection({
      files,
      changed,
      graph: () => {
        throw new Error('Graph must not be read')
      },
      timings: {},
      mode: 'selected',
      event: { pull_request: { draft: true } }
    })
    expect(plan.executionFiles).toEqual(files)
    expect(plan.selectionAvailable).toBe(false)
    expect(plan.shards).toHaveLength(FULL_SHARD_COUNT)
  })

  it('reads lazy graph evidence for source changes', () => {
    expect(selectUnitFiles(files, ['src/leaf.ts'], () => graph)).toEqual(
      selectUnitFiles(files, ['src/leaf.ts'], graph)
    )
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
    expect(selected.shards).toEqual([{ index: 1, count: 1 }])
  })

  it('spends five concurrency slots on a full run', () => {
    const plan = planUnitSelection({ files, changed: ['src/leaf.ts'], graph, timings: {} })
    expect(plan.shards).toEqual(
      Array.from({ length: FULL_SHARD_COUNT }, (_, index) => ({
        index: index + 1,
        count: FULL_SHARD_COUNT
      }))
    )
  })

  it('uses ten complete PR shards while selected drafts retain the five-shard cap', () => {
    const expandedSources = new Map(sources)
    for (let index = 0; index < 5; index++) {
      expandedSources.set(`src/additional-${index}.test.ts`, `import './leaf'`)
    }
    const expandedGraph = {
      ...buildUnitDependencyGraph(expandedSources),
      files: new Set(expandedSources.keys())
    }
    const expandedFiles = [...expandedSources.keys()]
      .filter((file) => file.endsWith('.test.ts'))
      .sort()
    const base = {
      files: expandedFiles,
      changed: ['src/leaf.ts'],
      graph: expandedGraph,
      fullShardCount: 10
    }
    const full = planUnitSelection({ ...base, timings: {} })
    expect(full.executionFiles).toEqual(expandedFiles)
    expect(full.shards).toEqual(
      Array.from({ length: 10 }, (_, index) => ({ index: index + 1, count: 10 }))
    )
    const selected = planUnitSelection({
      ...base,
      timings: Object.fromEntries(expandedFiles.map((file) => [file, 1_800_000])),
      mode: 'selected',
      event: { pull_request: { draft: true } }
    })
    expect(selected.shards).toHaveLength(5)
    expect(selected.executionFiles).toEqual(
      selectUnitFiles(expandedFiles, ['src/leaf.ts'], expandedGraph).files
    )
    expect(selected.executionFiles.length).toBeGreaterThan(5)
  })

  it('records failures that would have been missed while shadow runs remain full', () => {
    const plan = planUnitSelection({ files, changed: ['src/leaf.ts'], graph, timings: {} })
    expect(
      auditUnitSelection(plan, {
        'src/consumer.test.ts': 'failed',
        'src/unrelated.test.ts': 'failed',
        'src/view.test.ts': 'passed'
      }).omittedFailures
    ).toEqual(['src/unrelated.test.ts'])
  })
})
