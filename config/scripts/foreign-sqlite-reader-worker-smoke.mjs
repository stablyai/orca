import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describeProcessFailure, runProcessSync } from './script-child-process.mjs'
import { ORCAD_FOREIGN_SQLITE_READER_ENTRY } from '../../src/shared/orcad-artifacts.ts'

// Why a child process: the read must run under the runtime orcad ships, which may not be
// the Node running the build. The verdict is the exit code, never matched output.
const PROBE = `
const { Worker } = require('node:worker_threads')
const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
const [entry, dbPath, missingPath] = process.argv.slice(2)
const db = new DatabaseSync(dbPath)
db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL, time_created INTEGER NOT NULL, parent_id TEXT)')
db.prepare('INSERT INTO session VALUES (?, ?, ?, ?)').run('ses_smoke', '/smoke', 100, null)
db.close()
const steps = [
  {
    request: { id: 1, kind: 'openCodeBinderSessions', dbPath, cursor: { ms: 0, id: '' } },
    expected: [{ id: 'ses_smoke', directory: '/smoke', createdAtMs: 100, parentId: null }]
  },
  { request: { id: 2, kind: 'cursorProfile', dbPath: missingPath }, expected: { status: 'missing' } },
  // The OpenCode history scanner's kinds share this entry.
  { request: { id: 3, kind: 'list', dbPaths: [], limit: null }, expected: { candidates: [], issues: [] } }
]
const worker = new Worker(entry, { execArgv: [] })
const fail = (code, message) => {
  console.error(message)
  process.exit(code)
}
setTimeout(() => fail(3, 'foreign SQLite reader worker did not answer'), 20000).unref()
worker.on('error', (error) => fail(4, String(error && error.stack || error)))
worker.on('exit', (code) => fail(5, 'foreign SQLite reader worker exited with ' + code))
let step = 0
worker.on('message', (response) => {
  const { request, expected } = steps[step]
  if (!response || response.id !== request.id || response.ok !== true ||
      JSON.stringify(response.value) !== JSON.stringify(expected)) {
    fail(6, request.kind + ' answered ' + JSON.stringify(response))
  }
  step += 1
  if (step === steps.length) {
    process.exit(0)
  }
  worker.postMessage(steps[step].request)
})
worker.postMessage(steps[0].request)
`

/**
 * Load the built foreign SQLite reader entry and run real reads through it.
 * @param outDir - orcad output directory holding the entry.
 * @param options.runtimePath - Node to run under; the build's own Node when omitted.
 */
export function smokeForeignSqliteReaderWorker(outDir, { runtimePath, timeoutMs = 30_000 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-foreign-sqlite-smoke-'))
  try {
    const probe = join(directory, 'probe.cjs')
    writeFileSync(probe, PROBE)
    const result = runProcessSync({
      program: runtimePath ?? process.execPath,
      args: [
        probe,
        resolve(outDir, ORCAD_FOREIGN_SQLITE_READER_ENTRY),
        join(directory, 'opencode.db'),
        join(directory, 'missing.vscdb')
      ],
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
      timeoutMs,
      maxOutputBytes: 64 * 1024
    })
    if (result.code !== 0 || result.timedOut) {
      throw new Error(
        `Foreign SQLite reader worker smoke failed: ${describeProcessFailure(result)}`
      )
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
