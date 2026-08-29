import { renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { salvagePidFromCorruptDaemonRecord } from './daemon-pid-file-parse'
import { inspectProcessLiveness } from './daemon-process-inspection'

/**
 * A record that was just written is never quarantined: publishDaemonPidFile creates the record
 * before writing it (writeFileSync with flag 'wx'), so a concurrent launch can read a LIVE
 * daemon's record as empty or torn. Renaming it aside would strand that daemon's record, and the
 * next launch — seeing a complete listing with no record for its version — would reclaim the
 * running daemon's host image. An in-flight publish is by definition fresh; a record left corrupt
 * by a dead writer ages past this floor and is quarantined on a later launch.
 */
const QUARANTINE_MIN_RECORD_AGE_MS = 60_000

/**
 * A pid record that parses to nothing would otherwise veto daemon-host pruning on every future
 * launch: nothing ever rewrites a retired protocol version's pid file, so the veto never expires.
 * Quarantine the record (rename in place, bytes kept for diagnosis) so the next launch scans a
 * complete listing again — unless a process still answers for a pid salvaged from the corrupt
 * bytes, in which case the record may belong to a live daemon and keeps its conservative veto
 * until that pid exits. Returns the unverifiable reason; every branch is logged because this
 * state suppresses pruning.
 */
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
