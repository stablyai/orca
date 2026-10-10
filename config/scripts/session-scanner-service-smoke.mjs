import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describeProcessFailure, runProcessSync } from './script-child-process.mjs'
import { ORCAD_SESSION_SCANNER_SERVICE_ENTRY } from '../../src/shared/orcad-artifacts.ts'
import { AI_VAULT_SERVICE_PROTOCOL_VERSION } from '../../src/main/ai-vault/session-scanner-service-protocol.ts'

// Why fork from a probe: the child must run under the runtime orcad ships, and it forks with
// that runtime's execPath. The verdict is the exit code, never matched output.
const PROBE = `
const { fork } = require('node:child_process')
const [entry, home, protocol] = process.argv.slice(2)
const fail = (code, message) => {
  console.error(message)
  process.exit(code)
}
const child = fork(entry, [], {
  stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home },
  windowsHide: true
})
let stderr = ''
child.stderr.on('data', (chunk) => { stderr += String(chunk) })
setTimeout(() => { child.kill('SIGKILL'); fail(3, 'session scanner did not answer\\n' + stderr) }, 30000).unref()
child.on('error', (error) => fail(4, String(error && error.stack || error)))
child.on('exit', (code, signal) => fail(5, 'session scanner exited ' + code + ' ' + signal + '\\n' + stderr))
child.on('message', (message) => {
  if (message && message.type === 'ready') {
    child.send({ type: 'request', id: 1, operation: 'scan', options: { limit: 5 } })
    return
  }
  if (!message || message.id !== 1) {
    return
  }
  const sessions = message.type === 'result' ? message.value.result.sessions : []
  if (!sessions.some((session) => session.agent === 'claude' && session.sessionId === 'smoke-session')) {
    fail(6, 'scan answered ' + JSON.stringify(message).slice(0, 2000))
  }
  child.removeAllListeners('exit')
  child.kill()
  process.exit(0)
})
child.send({ type: 'init', protocol: Number(protocol) })
`

/**
 * Fork the built session scanner child and list a seeded Claude session through it.
 * @param outDir - orcad output directory holding the entry.
 * @param options.runtimePath - Node to run under; the build's own Node when omitted.
 */
export function smokeSessionScannerService(outDir, { runtimePath, timeoutMs = 60_000 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-session-scanner-smoke-'))
  try {
    const home = join(directory, 'home')
    const project = join(home, '.claude', 'projects', 'smoke-project')
    mkdirSync(project, { recursive: true })
    writeFileSync(
      join(project, 'smoke-session.jsonl'),
      `${JSON.stringify({
        type: 'user',
        sessionId: 'smoke-session',
        timestamp: '2026-01-01T00:00:00.000Z',
        cwd: '/smoke',
        message: { role: 'user', content: 'smoke' }
      })}\n`
    )
    const probe = join(directory, 'probe.cjs')
    writeFileSync(probe, PROBE)
    const result = runProcessSync({
      program: runtimePath ?? process.execPath,
      args: [
        probe,
        resolve(outDir, ORCAD_SESSION_SCANNER_SERVICE_ENTRY),
        home,
        String(AI_VAULT_SERVICE_PROTOCOL_VERSION)
      ],
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
      timeoutMs,
      maxOutputBytes: 64 * 1024
    })
    if (result.code !== 0 || result.timedOut) {
      throw new Error(`Session scanner service smoke failed: ${describeProcessFailure(result)}`)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
