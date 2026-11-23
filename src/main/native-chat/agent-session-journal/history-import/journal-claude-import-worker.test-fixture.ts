// @orca-isolated-worker -- Suite hooks own the temporary import worker bundle.
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll } from 'vitest'
import { setClaudeImportWorkerEntry } from './journal-claude-import-worker'

let bundleRoot = ''

beforeAll(async () => {
  bundleRoot = mkdtempSync(join(tmpdir(), 'orca-claude-import-worker-'))
  await build({
    entryPoints: [
      resolve(
        'src/main/native-chat/agent-session-journal/history-import/journal-claude-import-worker-entry.ts'
      )
    ],
    outdir: bundleRoot,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent'
  })
  setClaudeImportWorkerEntry(join(bundleRoot, 'journal-claude-import-worker-entry.js'))
})
afterAll(() => {
  setClaudeImportWorkerEntry(undefined)
  rmSync(bundleRoot, { recursive: true, force: true })
})
