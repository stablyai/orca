import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runProcessSync } from '@orca/process-host'
import { describeProcessFailure } from '../../tool-invocation/process-failure-message.mjs'

const PROBE = `
const { Worker } = require('node:worker_threads')
const { writeFileSync } = require('node:fs')
const [entry, source] = process.argv.slice(2)
writeFileSync(source, JSON.stringify({type:'user', uuid:'smoke-message', sessionId:'smoke-session',
  cwd:'/smoke', message:{content:'hello'}})+'\\n')
const worker = new Worker(entry, {execArgv:[], workerData:{agent:'claude', sessionId:'smoke-session',
  filePath:source, transcriptAgent:'claude', limits:{inlineHeadBytes:16384}, validateSource:true}})
let validated = false
let received = false
let failure
worker.on('error', error => {failure = error})
worker.on('message', message => {
  if (message.type === 'validate-source' && !validated &&
      message.observed.sessionId === 'smoke-session' && message.observed.cwd === '/smoke') {
    validated = true
    worker.postMessage({ok:true})
  } else if (message.type === 'result' && validated && !received && message.result.ok &&
      message.result.items.length === 1 && message.result.items[0].identity.uuid === 'smoke-message' &&
      message.result.items[0].body.blocks[0].text === 'hello') {
    received = true
  } else {
    failure = Error('invalid import response')
    void worker.terminate()
  }
})
worker.on('exit', code => {
  if (failure || code !== 0 || !received) {
    console.error(failure || 'import worker exited before completion')
    process.exitCode = 1
  }
})
`

/** Exercise the shipped worker, validation acknowledgement and natural exit before distribution. */
export function smokeLegacyImportWorker(outDir, { runtimePath, timeoutMs = 30_000 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-legacy-import-smoke-'))
  try {
    const probe = join(directory, 'probe.cjs')
    writeFileSync(probe, PROBE)
    const result = runProcessSync({
      program: runtimePath ?? process.execPath,
      args: [
        probe,
        resolve(outDir, 'journal-legacy-import-worker-entry.js'),
        join(directory, 'source.jsonl')
      ],
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
      timeoutMs,
      maxOutputBytes: 64 * 1024
    })
    if (result.code !== 0 || result.timedOut) {
      throw new Error(`History import worker smoke failed: ${describeProcessFailure(result)}`)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
