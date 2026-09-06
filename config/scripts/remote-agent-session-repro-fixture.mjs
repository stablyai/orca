#!/usr/bin/env node

import { appendFileSync, existsSync } from 'node:fs'

const markerPath = process.env.ORCA_REPRO_SPAWN_MARKER
const exitTriggerPath = process.env.ORCA_REPRO_EXIT_TRIGGER
const inputMarkerPath = process.env.ORCA_REPRO_INPUT_MARKER
const lifecycleMarkerPath = process.env.ORCA_REPRO_LIFECYCLE_MARKER
const agentSessionToken = process.env.ORCA_REPRO_AGENT_SESSION_TOKEN
if (!markerPath || !exitTriggerPath) {
  process.exit(2)
}

if (agentSessionToken && !process.argv.slice(2).includes(agentSessionToken)) {
  process.stderr.write("error: unrecognized subcommand 'app-server'\n")
  process.exit(2)
}

appendFileSync(
  markerPath,
  `${process.pid}:${process.ppid}:${Date.now()}:${JSON.stringify(process.argv.slice(2))}\n`
)
const recordLifecycle = (event) => {
  if (lifecycleMarkerPath) {
    appendFileSync(lifecycleMarkerPath, `${process.pid}:${process.ppid}:${Date.now()}:${event}\n`)
  }
}
recordLifecycle(
  `started:stdin-tty=${String(process.stdin.isTTY)}:stdout-tty=${String(process.stdout.isTTY)}`
)
process.stdout.write(`ORCA_REPRO_AGENT_READY:${process.pid}\r\n`)
if (inputMarkerPath) {
  process.stdin.setEncoding('utf8')
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
  }
  process.stdin.on('data', (chunk) => {
    recordLifecycle('input')
    appendFileSync(inputMarkerPath, chunk)
  })
  process.stdin.resume()
}

const interval = setInterval(() => {
  if (!existsSync(exitTriggerPath)) {
    return
  }
  recordLifecycle('exit-trigger')
  clearInterval(interval)
  try {
    // Why: the agent is a child of the startup shell; terminating that shell
    // produces a real PTY exit instead of merely returning to its prompt.
    process.kill(process.ppid, 'SIGTERM')
  } catch {
    // The parent may already have exited after the trigger was observed.
  }
  process.exit(0)
}, 25)

process.on('SIGTERM', () => {
  recordLifecycle('sigterm')
  process.exit(0)
})
process.on('SIGINT', () => {
  recordLifecycle('sigint')
  process.exit(0)
})
process.on('exit', (code) => recordLifecycle(`exit:${code}`))
