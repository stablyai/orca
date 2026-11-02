// Runs on the signed host binary so macOS permission checks, which follow the responsible process,
// keep treating this terminal as Orca. See native/terminal-anchor-macos/main.swift.
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, openSync, writeSync } from 'node:fs'
import { constants } from 'node:os'

const POLL_MS = Number(process.env.ORCA_TERMINAL_ANCHOR_POLL_MS) || 30_000

const [helper, statusFdText, , , file, ...args] = process.argv.slice(2)
const statusFd = Number(statusFdText)

// The kernel forgets a dead responsible process, so the anchor outlives the terminal's hangup.
for (const signal of [
  'SIGHUP',
  'SIGINT',
  'SIGQUIT',
  'SIGTERM',
  'SIGTSTP',
  'SIGTTIN',
  'SIGTTOU'
] as const) {
  process.on(signal, () => {})
}

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.ORCA_TERMINAL_ANCHOR_POLL_MS

function reportShellExit(code: number, signalNumber: number): void {
  try {
    writeSync(statusFd, `${code} ${signalNumber}\n`)
    closeSync(statusFd)
  } catch {
    // The launcher is gone: the terminal was closed first.
  }
}

/** Holding the PTY open would keep the terminal alive after its shell has gone. */
function releaseTerminal(): void {
  for (const descriptor of [0, 1, 2]) {
    closeSync(descriptor)
    openSync('/dev/null', descriptor === 0 ? 'r' : 'w')
  }
}

function isStillNamed(): boolean {
  const result = spawnSync(helper, ['count-responsible', String(process.pid)], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  })
  // A retired host copy has lost its helper; nothing can tell any more, so stop.
  return result.status === 0 && Number(result.stdout) > 0
}

function waitForDescendants(): void {
  if (!isStillNamed()) {
    process.exit(0)
  }
  setTimeout(waitForDescendants, POLL_MS)
}

let finished = false
function shellEnded(code: number, signalNumber: number): void {
  if (finished) {
    return
  }
  finished = true
  reportShellExit(code, signalNumber)
  releaseTerminal()
  waitForDescendants()
}

const shell = spawn(helper, ['exec-foreground', file, ...args], { stdio: 'inherit', env })
shell.on('error', () => shellEnded(127, 0))
shell.on('exit', (code, signal) => {
  shellEnded(code ?? 0, signal ? constants.signals[signal] : 0)
})
