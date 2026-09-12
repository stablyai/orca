import { mkdirSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'

export function writeMockNodePty(root: string, source: string, withPackageEntry = false): void {
  const nodePtyDir = path.join(root, 'node_modules', 'node-pty')
  const libDir = path.join(nodePtyDir, 'lib')
  mkdirSync(libDir, { recursive: true })
  if (withPackageEntry) {
    writeFileSync(path.join(nodePtyDir, 'package.json'), '{"main":"lib/index.js"}\n')
  }
  writeFileSync(path.join(libDir, 'index.js'), source)
}

export const WORKING_NODE_PTY_MODULE = `module.exports = { spawn() { return {
  pid: process.pid,
  process: 'mock-shell',
  onData() {}, onExit() {}, write() {}, resize() {}, kill() {}, clear() {}
} } }\n`

// A shell that reports its own exit after a delay, so the relay sees the pool drain on its own.
export function selfExitingNodePtyModule(exitAfterMs: number): string {
  return `module.exports = { spawn() {
  const exitHandlers = []
  setTimeout(() => { for (const cb of exitHandlers) { cb({ exitCode: 0, signal: 0 }) } }, ${exitAfterMs})
  return {
    pid: process.pid,
    process: 'mock-shell',
    onData() {}, onExit(cb) { exitHandlers.push(cb) }, write() {}, resize() {}, kill() {}, clear() {}
  }
} }\n`
}

// A shell whose first dispose is refused, so ptyHandler.dispose() rejects once before a retry can succeed.
export const KILL_REJECTS_FIRST_DISPOSE_MODULE = `let killAttempts = 0
module.exports = { spawn() {
  const exitHandlers = []
  return {
    pid: 2147483646,
    process: 'mock-shell',
    onData() {}, onExit(cb) { exitHandlers.push(cb) }, write() {}, resize() {}, clear() {},
    kill() {
      killAttempts++
      if (killAttempts <= 2) { throw new Error('kill refused') }
      setTimeout(() => { for (const cb of exitHandlers) { cb({ exitCode: 0, signal: 0 }) } }, 0)
    }
  }
} }\n`

// Why: an ESM mock with top-level await parks loadPty() in the window where a spawn is admitted but not yet pooled.
export function writeSlowLoadingNodePty(root: string, loadDelayMs: number): void {
  const nodePtyDir = path.join(root, 'node_modules', 'node-pty')
  mkdirSync(path.join(nodePtyDir, 'lib'), { recursive: true })
  writeFileSync(path.join(nodePtyDir, 'package.json'), '{"type":"module","main":"lib/index.js"}\n')
  writeFileSync(
    path.join(nodePtyDir, 'lib', 'index.js'),
    `await new Promise((resolve) => setTimeout(resolve, ${loadDelayMs}))
export function spawn() {
  const exitHandlers = []
  return {
    pid: process.pid,
    process: 'mock-shell',
    onData() {}, onExit(cb) { exitHandlers.push(cb) }, write() {}, resize() {}, clear() {},
    // Report the exit so relay shutdown can complete instead of parking on waitForPhysicalExit.
    kill() { setTimeout(() => { for (const cb of exitHandlers) { cb({ exitCode: 0, signal: 0 }) } }, 0) }
  }
}
`
  )
}
