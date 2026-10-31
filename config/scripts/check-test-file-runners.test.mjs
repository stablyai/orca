import { describe, expect, it } from 'vitest'
import { findRunnerDrift, findUncollectedTestFiles } from './check-test-file-runners.mjs'
import { classifyPrJobs } from './pr-code-change-scope.mjs'

const RUNNERS = [
  { name: 'unit', include: ['src/**/*.test.ts'], exclude: ['src/live/**'] },
  { name: 'live', include: ['src/live/**'], within: ['src/**/*.test.ts'] }
]
const SUITE = "import { it } from 'vitest'\nit('works', () => {})\n"

describe('findUncollectedTestFiles', () => {
  it('reports test files no runner collects, whatever their naming', () => {
    const sources = new Map([
      ['src/a.test.ts', SUITE],
      ['src/live/shell.test.ts', SUITE],
      ['src/live/shell-case.spec.ts', SUITE],
      ['src/orphan.spec.tsx', SUITE],
      ['src/budget.bench.ts', SUITE],
      ['tools/lease-check.mjs', "import { test } from 'node:test'\ntest('holds', () => {})\n"],
      ['src/not-a-test.ts', 'export const value = 1\n']
    ])
    expect(findUncollectedTestFiles(sources, RUNNERS)).toEqual([
      'src/live/shell-case.spec.ts',
      'src/orphan.spec.tsx',
      'src/budget.bench.ts',
      'tools/lease-check.mjs'
    ])
  })

  it('counts a suite module as collected only while a collected entry runtime-imports it', () => {
    const sources = new Map([
      [
        'src/page.test.ts',
        [
          "import './page.case.spec'",
          "import './twin.spec'",
          "import '@renderer/alias-one.spec'",
          "import '@/alias-two.spec.js'",
          "import './nested-suite'"
        ].join('\n')
      ],
      ['src/renderer/src/alias-one.spec.ts', SUITE],
      ['src/renderer/src/alias-two.spec.ts', SUITE],
      ['src/nested-suite/index.ts', SUITE],
      ['src/twin.spec.ts', SUITE],
      ['src/twin.spec.tsx', SUITE],
      ['src/page.case.spec.ts', `import './page-harness.spec'\n${SUITE}`],
      ['src/page-harness.spec.ts', 'export const harness = {}\n'],
      ['src/page.dropped.spec.ts', `import './page-harness.spec'\n${SUITE}`],
      [
        'src/types.test.ts',
        [
          "import type {\n  Shape\n} from './typed-import.spec'",
          "import { type Inline } from './inline-type.spec'",
          "export type { Shape } from './typed-export.spec'",
          'export type Alias = Record<string, number>',
          "export { run } from './after-alias.spec'",
          "type Suite = typeof import('./type-query.spec')",
          "import { Shape as UsedAsType } from './type-use.spec'",
          'export const shape: UsedAsType | null = null'
        ].join('\n')
      ],
      ['src/typed-import.spec.ts', SUITE],
      ['src/inline-type.spec.ts', SUITE],
      ['src/typed-export.spec.ts', SUITE],
      ['src/after-alias.spec.ts', SUITE],
      ['src/type-query.spec.ts', SUITE],
      ['src/type-use.spec.ts', SUITE]
    ])
    expect(findUncollectedTestFiles(sources, RUNNERS)).toEqual([
      'src/twin.spec.tsx',
      'src/page.dropped.spec.ts',
      'src/typed-import.spec.ts',
      'src/inline-type.spec.ts',
      'src/typed-export.spec.ts',
      'src/type-query.spec.ts',
      'src/type-use.spec.ts'
    ])
  })
})

describe('findRunnerDrift', () => {
  it('reports a runner whose sources no longer contain the include it mirrors', () => {
    const runners = [
      { name: 'kept', sources: ['a.config.ts'], mirrors: ["'src/**/*.test.ts'"] },
      { name: 'split', sources: ['a.config.ts', 'b.config.ts'], mirrors: ["'src/**/*.spec.ts'"] },
      { name: 'changed', sources: ['b.config.ts'], mirrors: ["'src/**/*.test.ts'"] },
      { name: 'deleted', sources: ['c.config.ts'], mirrors: [] }
    ]
    const files = {
      'a.config.ts': "include: ['src/**/*.test.ts']",
      'b.config.ts': "include: ['src/**/*.spec.ts']"
    }
    expect(findRunnerDrift(runners, (file) => files[file] ?? null)).toEqual([
      `changed: b.config.ts do not contain "'src/**/*.test.ts'"`,
      'deleted: c.config.ts is missing'
    ])
  })
})

// Why: cloud/ is outside the lint and format trees, so only these paths bring the check to a cloud-only diff.
it('runs the static job when a cloud diff touches code that could hold or run a test', () => {
  const routed = (file) => classifyPrJobs([file]).static_analysis
  expect(
    [
      'cloud/apps/push/src/new-case.spec.ts',
      'cloud/packages/push-contract/src/contract.test.ts',
      'cloud/package.json',
      'cloud/apps/relay/vitest.config.ts',
      'cloud/dev/scripts/lease-check.mjs'
    ].filter((file) => !routed(file))
  ).toEqual([])
  expect(routed('cloud/apps/relay/Dockerfile')).toBe(false)
})
