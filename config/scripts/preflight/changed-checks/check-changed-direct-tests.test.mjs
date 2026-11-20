import { describe, expect, it } from 'vitest'
import { importerPattern, selectImportingTests } from './check-changed-direct-tests.mjs'

describe('selectImportingTests', () => {
  it('selects tests whose relative, alias, or mock specifiers resolve to a changed module', () => {
    const changed = ['src/main/bots/bot-memory.ts', 'src/renderer/src/store/tabs/index.ts']
    const candidates = [
      ['src/main/bots/bot-memory.test.ts', "import { load } from './bot-memory'"],
      ['src/main/other/run.test.ts', "vi.mock('../bots/bot-memory.js', () => ({}))"],
      ['src/renderer/src/app.test.tsx', "import { tabs } from '@/store/tabs'"],
      ['src/main/cli/bot-memory.test.ts', "import { load } from './bot-memory'"]
    ]
    expect(selectImportingTests(changed, candidates)).toEqual([
      'src/main/bots/bot-memory.test.ts',
      'src/main/other/run.test.ts',
      'src/renderer/src/app.test.tsx'
    ])
  })

  it('prefilters explicit index imports of a changed index module', () => {
    const pattern = new RegExp(importerPattern(['src/main/bots/index.ts']))
    expect(pattern.test("import { run } from '../bots/index.js'")).toBe(true)
    expect(pattern.test("import { run } from '../bots'")).toBe(true)
  })
})
