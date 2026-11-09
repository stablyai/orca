import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { KeyedJsonRowCache } from './keyed-json-row-cache'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

const row = (key: string, value: string) => ({ key, json: JSON.stringify(value) })

it('saves exactly its own rows after another connection committed in between', () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-row-cache-'))
  directories.push(directory)
  const path = join(directory, 'cache.db')
  const first = new KeyedJsonRowCache(path, 1)
  const second = new KeyedJsonRowCache(path, 1)
  try {
    first.write([row('a', 'a1'), row('b', 'b1')])
    expect(second.load()).toEqual({ kind: 'rows', values: ['a1', 'b1'] })

    first.write([row('a', 'a2'), row('b', 'b1')])
    second.write([row('a', 'a1'), row('b', 'b2')])

    const reader = new KeyedJsonRowCache(path, 1)
    expect(reader.load()).toEqual({ kind: 'rows', values: ['a1', 'b2'] })
    reader.close()
  } finally {
    first.close()
    second.close()
  }
})
