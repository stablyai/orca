// @orca-isolated-worker -- Suite hooks own the temporary SQL worker bundle.
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll } from 'vitest'

let bundleRoot = ''

beforeAll(async () => {
  bundleRoot = mkdtempSync(join(tmpdir(), 'orca-journal-sql-worker-'))
  await build({
    entryPoints: [
      resolve('src/main/native-chat/agent-session-journal/journal-sql-worker-entry.ts'),
      resolve('src/main/native-chat/agent-session-journal/journal-sql-reader-entry.ts')
    ],
    outdir: bundleRoot,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent'
  })
})
afterAll(() => rmSync(bundleRoot, { recursive: true, force: true }))

export const journalSqlWorkerPath = (): string => join(bundleRoot, 'journal-sql-worker-entry.js')
export const journalSqlReaderPath = (): string => join(bundleRoot, 'journal-sql-reader-entry.js')
