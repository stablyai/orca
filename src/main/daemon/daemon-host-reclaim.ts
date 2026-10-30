import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { ProcessLivenessVerdict } from './daemon-incarnation-evidence-types'
import { inspectProcessLiveness } from './daemon-process-inspection'

const STAGING_PREFIX = '.staging-'

/** Staging dir name carrying its writer's pid, so a later launch can prove the copy was abandoned. */
export function daemonHostStagingName(writerPid: number, nonce: string): string {
  return `${STAGING_PREFIX}${writerPid}-${nonce}`
}

// Unparseable names (pre-pid layout) have no identifiable writer and are kept.
function stagingWriterVerdict(name: string): ProcessLivenessVerdict {
  const match = /^\.staging-(\d+)-[0-9a-f]+$/.exec(name)
  const pid = match ? Number(match[1]) : Number.NaN
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return { status: 'unverifiable', reason: 'the staging writer could not be identified' }
  }
  return inspectProcessLiveness(pid)
}

// Only positive exit evidence permits deletion; unknown verdicts must preserve the directory.
export function reclaimUnownedDaemonHostDir(
  verdict: ProcessLivenessVerdict,
  hostDir: string
): void {
  if (verdict.status !== 'exited') {
    return
  }
  try {
    rmSync(hostDir, { recursive: true, force: true })
  } catch {
    // Still locked or already gone — retry on a future launch.
  }
}

/** Daemons never run from staging; only its copying process can keep it live. */
export function reclaimAbandonedDaemonHostStaging(versionRoot: string): void {
  let entries
  try {
    entries = readdirSync(versionRoot, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }
    const dir = join(versionRoot, entry.name)
    if (entry.name.startsWith(STAGING_PREFIX)) {
      reclaimUnownedDaemonHostDir(stagingWriterVerdict(entry.name), dir)
    }
  }
}
