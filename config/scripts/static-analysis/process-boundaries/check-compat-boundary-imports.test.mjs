import { describe, expect, it } from 'vitest'
import { assessCompatBoundaryImports } from './check-compat-boundary-imports.mjs'

const folders = [
  { folder: 'src/main/compat', entries: ['entry'], importers: ['src/main/owner.ts'] },
  { folder: 'src/renderer/src/runtime/frozen', entries: ['entry'], importers: [] }
]

function assess(files) {
  return assessCompatBoundaryImports(new Map(Object.entries(files)), folders)
}

describe('compatibility folder import boundary', () => {
  it('rejects a deep import whose folder name is escaped', () => {
    const specifier = './co\\u006dpat/a'
    expect(assess({ 'src/main/owner.ts': `import { a } from '${specifier}'` })).toEqual([
      'src/main/owner.ts: import src/main/compat through entry, not ./compat/a'
    ])
  })

  it('checks const-bound loaders and dot segments', () => {
    expect(
      assess({
        'src/main/other.ts': "const entry = './compat/nested/../entry'; require(entry)",
        'src/renderer/src/store.ts': "export { f } from '@renderer/runtime/frozen/inner/../a'"
      })
    ).toEqual([
      'src/main/other.ts: only src/main/owner.ts may import src/main/compat',
      'src/renderer/src/store.ts: import src/renderer/src/runtime/frozen through entry, not @renderer/runtime/frozen/inner/../a'
    ])
  })

  it('checks imports inherited from a compatibility folder in the file path', () => {
    expect(
      assessCompatBoundaryImports(
        new Map([['src/main/compat.ts/consumer.ts', "import { a } from '.'"]]),
        [{ folder: 'src/main/compat', entries: ['entry'], importers: [] }]
      )
    ).toEqual(['src/main/compat.ts/consumer.ts: import src/main/compat through entry, not .'])
  })
})
