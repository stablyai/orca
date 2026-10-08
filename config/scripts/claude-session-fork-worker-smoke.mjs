import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describeProcessFailure, runProcessSync } from './script-child-process.mjs'
import {
  CLAUDE_TWO_TURN_FIRST_ANSWER,
  CLAUDE_TWO_TURN_SESSION_ID,
  CLAUDE_TWO_TURN_TRANSCRIPT
} from '../../src/main/claude/claude-two-turn-transcript.test-fixture.ts'
import { ORCAD_CLAUDE_SESSION_FORK_WORKER_ENTRY } from '../../src/shared/orcad-artifacts.ts'

const ROOT = join(import.meta.dirname, '..', '..')

// Why a child process: the copy must run under the runtime orcad ships, which may not be the Node
// running the build. Why a real copy: the bundled SDK only fails once it is loaded and called. The
// verdict is the exit code, never matched output.
const PROBE = `
const { Worker } = require('node:worker_threads')
const [entry, configDir, providerSessionId, upToMessageId] = process.argv.slice(2)
const fail = (code, message) => {
  console.error(message)
  process.exit(code)
}
const worker = new Worker(entry, {
  execArgv: [],
  workerData: { providerSessionId, upToMessageId },
  env: { ...process.env, CLAUDE_CONFIG_DIR: configDir }
})
setTimeout(() => fail(3, 'Claude session fork worker did not answer'), 20000).unref()
worker.on('error', (error) => fail(4, String(error && error.stack || error)))
worker.on('message', (reply) => {
  if (!reply || reply.ok !== true) {
    fail(5, 'fork answered ' + JSON.stringify(reply))
  }
  process.exit(0)
})
`

/**
 * Load the built Claude session fork worker and have it copy a real transcript.
 * @param outDir - orcad output directory holding the entry.
 * @param options.runtimePath - Node to run under; the build's own Node when omitted.
 */
export function smokeClaudeSessionForkWorker(outDir, { runtimePath, timeoutMs = 30_000 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-claude-fork-smoke-'))
  try {
    const probe = join(directory, 'probe.cjs')
    const projectDir = join(directory, 'projects', '-workspace')
    writeFileSync(probe, PROBE)
    mkdirSync(projectDir, { recursive: true })
    copyFileSync(
      join(ROOT, CLAUDE_TWO_TURN_TRANSCRIPT),
      join(projectDir, `${CLAUDE_TWO_TURN_SESSION_ID}.jsonl`)
    )
    const result = runProcessSync({
      program: runtimePath ?? process.execPath,
      args: [
        probe,
        resolve(outDir, ORCAD_CLAUDE_SESSION_FORK_WORKER_ENTRY),
        directory,
        CLAUDE_TWO_TURN_SESSION_ID,
        CLAUDE_TWO_TURN_FIRST_ANSWER
      ],
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
      timeoutMs,
      maxOutputBytes: 64 * 1024
    })
    if (result.code !== 0 || result.timedOut) {
      throw new Error(`Claude session fork worker smoke failed: ${describeProcessFailure(result)}`)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
