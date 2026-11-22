import { describe, expect, it } from 'vitest'
import { findUncollectedTestFiles } from './check-test-file-runners.mjs'

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
