import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  FOREIGN_SQLITE_READER_ENTRY_FILENAME as ENTRY,
  resolveForeignSqliteReaderEntryPath
} from './foreign-sqlite-reader-entry-path'
import { ORCAD_FOREIGN_SQLITE_READER_ENTRY } from '../../shared/orcad-artifacts'

const unpackaged = (moduleDir: string) => ({
  isPackaged: false,
  resourcesPath: undefined,
  moduleDir
})

describe('resolveForeignSqliteReaderEntryPath', () => {
  it('looks for the file name the orcad build emits', () => {
    expect(ENTRY).toBe(ORCAD_FOREIGN_SQLITE_READER_ENTRY)
  })

  it('resolves the entry beside a dev bundle', () => {
    const expected = join('out', 'main', ENTRY)
    expect(
      resolveForeignSqliteReaderEntryPath(
        unpackaged(join('out', 'main')),
        (path) => path === expected
      )
    ).toBe(expected)
  })

  it('resolves the root entry from a shared Rollup chunk', () => {
    const expected = join('out', 'main', ENTRY)
    expect(
      resolveForeignSqliteReaderEntryPath(
        unpackaged(join('out', 'main', 'chunks')),
        (path) => path === expected
      )
    ).toBe(expected)
  })

  it('names the adjacent path when neither candidate exists', () => {
    expect(resolveForeignSqliteReaderEntryPath(unpackaged(join('out', 'main')), () => false)).toBe(
      join('out', 'main', ENTRY)
    )
  })

  it('resolves inside app.asar in a packaged build', () => {
    const resourcesPath = join('Orca.app', 'Contents', 'Resources')
    expect(
      resolveForeignSqliteReaderEntryPath(
        {
          isPackaged: true,
          resourcesPath,
          moduleDir: join(resourcesPath, 'app.asar', 'out', 'main', 'chunks')
        },
        () => false
      )
    ).toBe(join(resourcesPath, 'app.asar', 'out', 'main', ENTRY))
  })

  it('falls back to the module dir on a packaged host with no Electron resources', () => {
    const expected = join('orcad', ENTRY)
    expect(
      resolveForeignSqliteReaderEntryPath(
        { isPackaged: true, resourcesPath: undefined, moduleDir: 'orcad' },
        (path) => path === expected
      )
    ).toBe(expected)
  })
})
