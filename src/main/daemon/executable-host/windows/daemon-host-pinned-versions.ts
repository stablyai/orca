import { readFileSync, readdirSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProcessLivenessVerdict } from '../../endpoint/identity/daemon-incarnation-evidence-types'
import { parseDaemonPidFile } from '../../endpoint/identity/daemon-pid-file-parse'
import { quarantineCorruptDaemonPidRecord } from '../../endpoint/identity/daemon-pid-record-quarantine'
import {
  inspectProcessLiveness,
  mergeProcessLivenessVerdict
} from '../../endpoint/identity/daemon-process-inspection'

export type PinnedDaemonVersionsEvidence =
  | { status: 'complete'; versionLiveness: ReadonlyMap<string, ProcessLivenessVerdict> }
  | { status: 'unverifiable'; reason: string }

/** Pin versions conservatively by PID liveness; unreadable records veto pruning. */
export function collectPinnedDaemonVersions(runtimeDir: string): PinnedDaemonVersionsEvidence {
  const versionLiveness = new Map<string, ProcessLivenessVerdict>()
  let entries
  try {
    entries = readdirSync(runtimeDir, { withFileTypes: true })
  } catch {
    return { status: 'unverifiable', reason: 'the daemon runtime directory could not be read' }
  }
  for (const entry of entries) {
    if (!entry.isFile() || !/^daemon-v\d+\.pid$/.test(entry.name)) {
      continue
    }
    let contents
    try {
      contents = readFileSync(join(runtimeDir, entry.name), 'utf8')
    } catch {
      // Read failures veto this prune; retry from the record on the next launch.
      return {
        status: 'unverifiable',
        reason: `the daemon pid file could not be read: ${entry.name}`
      }
    }
    const parsed = parseDaemonPidFile(contents)
    // Records are empty during publication; a torn record must veto pruning instead of appearing legacy.
    if (!parsed || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
      return {
        status: 'unverifiable',
        reason: quarantineCorruptDaemonPidRecord(runtimeDir, entry.name, contents)
      }
    }
    // Pre-relocation daemons run from the install directory and pin no relocated host.
    if (parsed.appVersion === null) {
      continue
    }
    const verdict = inspectProcessLiveness(parsed.pid)
    versionLiveness.set(
      parsed.appVersion,
      mergeProcessLivenessVerdict(versionLiveness.get(parsed.appVersion), verdict)
    )
  }
  return { status: 'complete', versionLiveness }
}

/** Removal-time re-check: same verdicts read off the event loop; corrupt records veto without quarantine. */
export async function recheckPinnedDaemonVersions(
  runtimeDir: string
): Promise<PinnedDaemonVersionsEvidence> {
  const versionLiveness = new Map<string, ProcessLivenessVerdict>()
  let names
  try {
    names = (await readdir(runtimeDir)).filter((name) => /^daemon-v\d+\.pid$/.test(name))
  } catch {
    return { status: 'unverifiable', reason: 'the daemon runtime directory could not be read' }
  }
  for (const name of names) {
    const parsed = parseDaemonPidFile(
      await readFile(join(runtimeDir, name), 'utf8').catch(() => '')
    )
    if (!parsed || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
      return { status: 'unverifiable', reason: `the daemon pid file is unreadable: ${name}` }
    }
    if (parsed.appVersion !== null) {
      versionLiveness.set(
        parsed.appVersion,
        mergeProcessLivenessVerdict(
          versionLiveness.get(parsed.appVersion),
          inspectProcessLiveness(parsed.pid)
        )
      )
    }
  }
  return { status: 'complete', versionLiveness }
}
