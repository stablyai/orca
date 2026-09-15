import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { ParsedDaemonPid } from './daemon-pid-file-parse'

const deniedRecords = new Set<string>()

function recordKey(record: ParsedDaemonPid): string | null {
  if (!record.launchNonce && record.startedAtMs === null) {
    return null
  }
  return JSON.stringify([record.pid, record.startedAtMs, record.launchNonce])
}

export function hasDaemonTccDenial(record: ParsedDaemonPid, pidPath: string): boolean {
  const key = recordKey(record)
  if (!key) {
    return false
  }
  if (deniedRecords.has(key)) {
    return true
  }
  try {
    return readFileSync(`${pidPath}.tcc-denial`, 'utf8') === key
  } catch {
    return false
  }
}

export function rememberDaemonTccDenial(record: ParsedDaemonPid, pidPath?: string | null): void {
  const key = recordKey(record)
  if (!key) {
    return
  }
  deniedRecords.add(key)
  if (!pidPath) {
    return
  }
  try {
    const temporaryPath = `${pidPath}.tcc-denial.${process.pid}.tmp`
    writeFileSync(temporaryPath, key, { mode: 0o600 })
    renameSync(temporaryPath, `${pidPath}.tcc-denial`)
  } catch {
    // Persistence failure must not prevent the in-memory safety transition.
  }
}
