// Scan executables to cover pre-lease builds and exec-to-lease races without costly process maps.
import { readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import type { ProcessLivenessVerdict } from '../daemon/daemon-incarnation-evidence-types'

export type ProcReader = {
  listPids(): string[]
  ownerUid(pid: string): number
  readExe(pid: string): string
}

export type ResidentExecutableScan =
  | { status: 'scanned'; executables: readonly string[]; unreadablePid: string | null }
  | { status: 'unavailable' }

const linuxProcReader: ProcReader = {
  listPids: () => readdirSync('/proc').filter((name) => /^\d+$/u.test(name)),
  ownerUid: (pid) => statSync(`/proc/${pid}`).uid,
  readExe: (pid) => readlinkSync(`/proc/${pid}/exe`)
}

export function scanResidentExecutables(
  options: { proc?: ProcReader; uid?: number; platform?: NodeJS.Platform } = {}
): ResidentExecutableScan {
  if ((options.platform ?? process.platform) !== 'linux') {
    return { status: 'scanned', executables: [], unreadablePid: null }
  }
  const proc = options.proc ?? linuxProcReader
  const uid = options.uid ?? process.getuid?.() ?? -1
  let pids: string[]
  try {
    pids = proc.listPids()
  } catch {
    return { status: 'unavailable' }
  }
  const executables: string[] = []
  let unreadablePid: string | null = null
  for (const pid of pids) {
    try {
      if (proc.ownerUid(pid) === uid) {
        executables.push(proc.readExe(pid))
      }
    } catch (error) {
      // Exited processes cannot be resident; non-dumpable processes can deny /proc access.
      // Orca is dumpable and holds leases; unexpected errors could hide a resident.
      if (!['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].some((code) => hasErrorCode(error, code))) {
        unreadablePid = pid
      }
    }
  }
  return { status: 'scanned', executables, unreadablePid }
}

export function residencyOfGeneration(
  scan: ResidentExecutableScan,
  rootPath: string
): ProcessLivenessVerdict {
  if (scan.status === 'unavailable') {
    return { status: 'unverifiable', reason: '/proc unreadable' }
  }
  const prefixes = rootPrefixes(rootPath)
  // A deleted executable renders as "<path> (deleted)", which still starts with the root.
  if (scan.executables.some((exe) => prefixes.some((prefix) => exe.startsWith(prefix)))) {
    return { status: 'live' }
  }
  return scan.unreadablePid === null
    ? { status: 'exited' }
    : { status: 'unverifiable', reason: `process ${scan.unreadablePid} unreadable` }
}

function rootPrefixes(rootPath: string): string[] {
  const prefixes = new Set([resolve(rootPath)])
  try {
    prefixes.add(realpathSync(rootPath))
  } catch {}
  return [...prefixes].map((prefix) => `${prefix}${sep}`)
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}
