import { createHash } from 'node:crypto'
import type * as FileSystem from 'node:fs'
import { readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'

it('re-derives SQLite assignments from malformed disposable cache data', async () => {
  const version = createHash('sha256')
    .update(readFileSync(new URL('./vitest-sqlite-runtime-scan.mjs', import.meta.url)))
    .digest('hex')
  for (const files of [null, { 'fixture.test.ts': [1, 2, 'false'] }]) {
    vi.doMock('node:fs', async (original) => ({
      ...(await original<typeof FileSystem>()),
      globSync: () => ['fixture.test.ts'],
      statSync: () => ({ mtimeMs: 1, size: 2 }),
      readFileSync: (path: Parameters<typeof readFileSync>[0]) =>
        String(path).endsWith('.json')
          ? JSON.stringify({ version, files })
          : String(path).endsWith('fixture.test.ts')
            ? 'export {}'
            : readFileSync(path),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      renameSync: vi.fn()
    }))
    vi.resetModules()
    try {
      const { findSqliteRuntimeTests } = await import('./vitest-sqlite-runtime-scan.mjs')
      expect(findSqliteRuntimeTests()).toEqual([])
    } finally {
      vi.doUnmock('node:fs')
      vi.resetModules()
    }
  }
})
