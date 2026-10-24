/**
 * Slots a live terminal daemon still runs from. Local `orca serve` forks its daemon from its own
 * slot, and that daemon outlives orcad, so the instance lock alone stops naming the slot.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseDaemonPidFile } from '../daemon/daemon-pid-file-parse'
import { hasErrorCode, isProcessAlive } from '../daemon/daemon-process-inspection'
import {
  currentOrcadPeerMachine,
  orcadPeerPidIsJudgeableHere,
  type OrcadPeerMachine
} from './orcad-lock-holder-locality'
import { orcadDataRootIsOnLocalDisk } from './orcad-data-root-locality'

/** This machine, for telling a peer record's PID apart from one another machine issued. */
export type OrcadSlotPeerJudge = {
  self: OrcadPeerMachine
  dataRootIsOnLocalDisk: (dataRoot: string) => boolean
}

export function defaultOrcadSlotPeerJudge(): OrcadSlotPeerJudge {
  return { self: currentOrcadPeerMachine(), dataRootIsOnLocalDisk: orcadDataRootIsOnLocalDisk }
}

const DAEMON_PID_FILE = /^daemon-v\d+\.pid$/u

/** Slot names under `cacheRoot` holding a live daemon's entry or runtime; null when unprovable. */
export function liveDaemonOrcadSlots(
  userDataPath: string,
  cacheRoot: string,
  isAlive: (pid: number) => boolean = isProcessAlive,
  judge: OrcadSlotPeerJudge = defaultOrcadSlotPeerJudge()
): string[] | null {
  const runtimeDir = join(userDataPath, 'daemon')
  let names: string[]
  try {
    names = readdirSync(runtimeDir)
  } catch (error) {
    // No daemon directory means no daemon; anything else leaves the slots unprovable.
    return hasErrorCode(error, 'ENOENT') ? [] : null
  }
  const slots: string[] = []
  for (const name of names.filter((candidate) => DAEMON_PID_FILE.test(candidate))) {
    let record
    try {
      record = parseDaemonPidFile(readFileSync(join(runtimeDir, name), 'utf8'))
    } catch {
      return null
    }
    if (!record || !Number.isInteger(record.pid) || record.pid <= 0) {
      // A record being written or torn names no process we could rule out.
      return null
    }
    // A daemon on another machine or boot (a shared home) is unverifiable here; keep its slot.
    const judgeable = orcadPeerPidIsJudgeableHere(
      { bootId: record.bootId ?? undefined },
      judge.self,
      () => judge.dataRootIsOnLocalDisk(userDataPath)
    )
    if (judgeable && !isAlive(record.pid)) {
      continue
    }
    for (const path of [record.entryPath, record.spawnerExecPath]) {
      const slot = path ? slotContaining(cacheRoot, path) : null
      if (slot) {
        slots.push(slot)
      }
    }
  }
  return slots
}

function slotContaining(cacheRoot: string, path: string): string | null {
  const rel = relative(resolve(cacheRoot), resolve(path))
  const [target, slot] = rel.split(sep)
  return rel && !isAbsolute(rel) && target !== '..' && target && slot ? slot : null
}
