#!/usr/bin/env node

import { appendFileSync, existsSync } from 'node:fs'

const markerPath = process.env.ORCA_REPRO_SPAWN_MARKER
const exitTriggerPath = process.env.ORCA_REPRO_EXIT_TRIGGER
if (!markerPath || !exitTriggerPath) {
  process.exit(2)
}

appendFileSync(markerPath, `${process.pid}:${process.ppid}\n`)

const interval = setInterval(() => {
  if (!existsSync(exitTriggerPath)) {
    return
  }
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

process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
