import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { smokeForeignSqliteReaderWorker } from './foreign-sqlite-reader-worker-smoke.mjs'
import { ORCAD_CHILD_ENTRY_POINTS } from './orcad-entry-build.mjs'

const ENTRY = 'foreign-sqlite-reader-entry.js'
const directories = []
let builtDirectory

function fixtureDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-foreign-sqlite-smoke-test-'))
  directories.push(directory)
  return directory
}

beforeAll(async () => {
  builtDirectory = fixtureDirectory()
  await build({
    entryPoints: [resolve(ORCAD_CHILD_ENTRY_POINTS.foreignSqliteReader)],
    outfile: join(builtDirectory, ENTRY),
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    external: ['electron'],
    logLevel: 'silent'
  })
}, 60_000)

afterAll(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('foreign SQLite reader build smoke', () => {
  it('passes against the built entry', () => {
    expect(() => smokeForeignSqliteReaderWorker(builtDirectory)).not.toThrow()
  })
})
