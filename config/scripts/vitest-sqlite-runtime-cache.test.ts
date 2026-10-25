import { createHash } from 'node:crypto'
import type * as FileSystem from 'node:fs'
import { readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'

it('re-derives SQLite assignments from malformed disposable cache data', async () => {
  const version = createHash('sha256')
    .update(readFileSync(new URL('./vitest-sqlite-runtime-scan.mjs', import.meta.url)))
    .digest('hex')
  for (const files of [null, { 'fixture.test.ts': [1, 2, 'false'] }]) {
    for (const [source, expected] of [
      ['export {}', []],
      ["import './src/main/sqlite/sync-database'", ['fixture.test.ts']]
    ] as const) {
      vi.doMock('node:fs', async (original) => ({
        ...(await original<typeof FileSystem>()),
        globSync: () => ['fixture.test.ts'],
        statSync: () => ({ mtimeMs: 1, size: 2 }),
        readFileSync: (path: Parameters<typeof readFileSync>[0]) =>
          String(path).endsWith('.json')
            ? JSON.stringify({ version, files })
            : String(path).endsWith('fixture.test.ts')
              ? source
              : readFileSync(path),
        mkdirSync: vi.fn(),
        writeFileSync: vi.fn(),
        renameSync: vi.fn()
      }))
      vi.resetModules()
      try {
        const { findSqliteRuntimeTests } = await import('./vitest-sqlite-runtime-scan.mjs')
        expect(findSqliteRuntimeTests()).toEqual(expected)
      } finally {
        vi.doUnmock('node:fs')
        vi.resetModules()
      }
    }
  }
})

it('classifies only selected tests without touching unrelated test sources', async () => {
  const stat = vi.fn((file: string) => {
    if (file.endsWith('two.test.ts')) {
      throw new Error('Unrelated test was scanned')
    }
    return { mtimeMs: 1, size: 2 }
  })
  vi.doMock('node:fs', async (original) => ({
    ...(await original<typeof FileSystem>()),
    globSync: () => ['src/one.test.ts', 'src/two.test.ts'],
    statSync: stat,
    readFileSync: (path: Parameters<typeof readFileSync>[0]) =>
      String(path).endsWith('.json')
        ? '{}'
        : String(path).endsWith('one.test.ts')
          ? "import './main/sqlite/sync-database'"
          : readFileSync(path),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    renameSync: vi.fn()
  }))
  vi.resetModules()
  try {
    const { findSqliteRuntimeTests } = await import('./vitest-sqlite-runtime-scan.mjs')
    expect(findSqliteRuntimeTests({ filters: ['src/one.test.ts'] })).toEqual(['src/one.test.ts'])
    expect(stat).toHaveBeenCalledTimes(1)
  } finally {
    vi.doUnmock('node:fs')
    vi.resetModules()
  }
})
