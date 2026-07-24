import { describe, expect, it } from 'vitest'
import { collectOpenCodeDatabaseFiles } from './opencode-database-files'

function entry(name: string, file = true): { name: string; isFile(): boolean } {
  return { name, isFile: () => file }
}

describe('OpenCode database file discovery', () => {
  it('preserves and sorts every matching file within the limit', async () => {
    const result = await collectOpenCodeDatabaseFiles(
      '/data',
      (async function* () {
        yield entry('opencode-z.db')
        yield entry('notes.txt')
        yield entry('opencode.db')
        yield entry('opencode-directory.db', false)
      })(),
      2
    )

    expect(result).toEqual({
      paths: ['/data/opencode-z.db', '/data/opencode.db'].sort(),
      truncated: false
    })
  })

  it('stops retaining names immediately after the database count limit', async () => {
    let enumerated = 0
    const result = await collectOpenCodeDatabaseFiles(
      '/data',
      (async function* () {
        for (const name of ['opencode-a.db', 'opencode-b.db', 'opencode-c.db', 'opencode-d.db']) {
          enumerated += 1
          yield entry(name)
        }
      })(),
      2
    )

    expect(result).toEqual({
      paths: ['/data/opencode-a.db', '/data/opencode-b.db'],
      truncated: true
    })
    expect(enumerated).toBe(3)
  })
})
