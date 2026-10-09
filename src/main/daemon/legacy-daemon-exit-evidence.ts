import { readFileSync } from 'node:fs'
import type { ProcessLivenessVerdict } from './daemon-incarnation-evidence-types'
import type { IPtyProvider } from '../providers/types'
import { parseDaemonPidFile, type ParsedDaemonPid } from './daemon-pid-file-parse'
import { inspectProcessLiveness, mergeProcessLivenessVerdict } from './daemon-process-inspection'

/**
 * Whether the process behind a preserved older-protocol daemon has exited, judged by every pid
 * known for it: the record read when the adapter adopted it, and the record on disk now. A daemon
 * unlinks its own record on an orderly exit, so a missing file is not itself proof; only a pid
 * that no process answers for is. "Exited" needs every known pid gone, so a recycled pid or an
 * unreadable record keeps the verdict live or unverifiable and the caller still fails closed.
 */
export function legacyDaemonProcessLiveness(
  pidPath: string | null,
  adoptedRecord: ParsedDaemonPid | null
): ProcessLivenessVerdict {
  const pids = new Set<number>()
  if (adoptedRecord) {
    pids.add(adoptedRecord.pid)
  }
  if (pidPath) {
    let contents: string | null = null
    try {
      contents = readFileSync(pidPath, 'utf8')
    } catch (error) {
      if (!isMissingFileError(error)) {
        return { status: 'unverifiable', reason: 'the daemon pid file could not be read' }
      }
    }
    if (contents !== null) {
      const parsed = parseDaemonPidFile(contents)
      if (!parsed) {
        return { status: 'unverifiable', reason: 'the daemon pid file could not be parsed' }
      }
      pids.add(parsed.pid)
    }
  }
  let verdict: ProcessLivenessVerdict | undefined
  for (const pid of pids) {
    verdict = mergeProcessLivenessVerdict(verdict, inspectProcessLiveness(pid))
  }
  return verdict ?? { status: 'unverifiable', reason: 'no pid record names the daemon process' }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

/** Adapter sets exclude an adapter whose daemon exited; it owns no session and never will. */
export function isExitedDaemonProvider(provider: IPtyProvider): boolean {
  return provider.hasDaemonExited?.() === true
}

export function withoutExitedDaemons<T extends IPtyProvider>(providers: readonly T[]): T[] {
  return providers.filter((provider) => !isExitedDaemonProvider(provider))
}
