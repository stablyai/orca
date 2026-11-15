import { renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { salvagePidFromCorruptDaemonRecord } from './daemon-pid-file-parse'
import { inspectProcessLiveness } from './daemon-process-inspection'

// Publishing creates the file before writing; protect fresh or torn live records from host-image reclamation.
const QUARANTINE_MIN_RECORD_AGE_MS = 60_000

/** Quarantine aged corrupt records to unblock pruning, unless a salvaged PID may still be live. */
export function quarantineCorruptDaemonPidRecord(
  runtimeDir: string,
  name: string,
  contents: string
): string {
  const salvagedPid = salvagePidFromCorruptDaemonRecord(contents)
  if (salvagedPid !== null && inspectProcessLiveness(salvagedPid).status !== 'exited') {
    const reason = `the daemon pid file could not be parsed and salvaged pid ${salvagedPid} may still be running: ${name}`
    console.warn(`[daemon] Keeping corrupt daemon pid record: ${reason}`)
    return reason
  }
  const recordPath = join(runtimeDir, name)
  let modifiedAtMs: number
  try {
    modifiedAtMs = statSync(recordPath).mtimeMs
  } catch {
    const reason = `the daemon pid file could not be parsed or aged: ${name}`
    console.warn(`[daemon] ${reason}`)
    return reason
  }
  // A future mtime (clock adjustment) reads as negative age and is treated as fresh.
  if (Date.now() - modifiedAtMs < QUARANTINE_MIN_RECORD_AGE_MS) {
    const reason = `the daemon pid file could not be parsed and was written too recently to quarantine: ${name}`
    console.warn(`[daemon] Keeping corrupt daemon pid record: ${reason}`)
    return reason
  }
  try {
    renameSync(recordPath, join(runtimeDir, `${name}.corrupt`))
  } catch {
    const reason = `the daemon pid file could not be parsed or quarantined: ${name}`
    console.warn(`[daemon] ${reason}`)
    return reason
  }
  const reason = `the daemon pid file could not be parsed and was quarantined: ${name}`
  console.warn(`[daemon] ${reason}`)
  return reason
}
