import { lstat, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { privateRuntimeDirectoryCandidates } from '../filesystem/private-runtime-directory'
import {
  createKeyScan,
  errorCode,
  groupHasLiveMember,
  type KeyedProcess,
  readProcStat,
  runsArgv
} from './proc-process-table'

/** Every child the isolated spawner starts carries its own value; its descendants inherit it. */
export const SPAWN_KEY_ENV = 'ORCA_SPAWN_KEY'
export const SPAWN_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export const SPAWN_RECORDS_DIR_NAME = 'orca-spawns'

const FIRST_CHECK_MS = 50
const MAX_CHECK_MS = 30_000

/** The lost launcher process, from its 'ready'. */
export type LostLauncher = { pid: number; cmdline: string; startTicks: number; sid: number }

export type LostSpawn = {
  key: string
  /** The pid main heard, if any. */
  pid?: number
  /** Main heard that the launcher recorded this child. */
  recorded: boolean
  /** Started as its own process group and session (a termination barrier): the group must end. */
  ownsGroup: boolean
  argv: readonly string[]
}

type KeyProof = { kind: 'key'; seen: boolean; quietScans: number }
/** How a lost child is proven ended. */
type Proof =
  | { kind: 'record' }
  /** `leaderStartTicks`: the leader's start time when known, so a reused group id is never hit. */
  | { kind: 'group'; groupId: number; leaderStartTicks?: number }
  | { kind: 'root'; pid: number; startTicks: number }
  | KeyProof

type RecordRead = { pid: number; startTicks: number } | 'absent' | 'partial' | 'unreadable'

async function readSpawnRecord(dir: string | null, key: string): Promise<RecordRead> {
  if (!dir) {
    return 'absent'
  }
  let text: string
  try {
    text = await readFile(join(dir, key), 'utf8')
  } catch (error) {
    // Only a record that is gone says anything; a failed read is tried again.
    return errorCode(error) === 'ENOENT' ? 'absent' : 'unreadable'
  }
  const [pid, startTicks] = text.split(' ').map(Number)
  // The launcher died mid-write: the child exists or is about to, so it is found by its key.
  return Number.isInteger(pid) && pid > 0 && Number.isInteger(startTicks)
    ? { pid, startTicks }
    : 'partial'
}

function proofFor(spawn: LostSpawn, record: RecordRead, recordDir: string | null): Proof {
  if (typeof record === 'object') {
    return spawn.ownsGroup
      ? { kind: 'group', groupId: record.pid, leaderStartTicks: record.startTicks }
      : { kind: 'root', pid: record.pid, startTicks: record.startTicks }
  }
  // The launcher removes a record only after that child, and an owned group, has ended, so a
  // missing one proves that only for a child main heard was recorded. Any other is found by its
  // key, or before its exec as a fork of the launcher.
  if (record === 'absent' && recordDir && spawn.recorded) {
    return { kind: 'record' }
  }
  // Main heard this barrier child's pid, and it leads its own group: end that group as a local stop would.
  if (spawn.ownsGroup && spawn.pid !== undefined) {
    return { kind: 'group', groupId: spawn.pid }
  }
  return { kind: 'key', seen: false, quietScans: 0 }
}

async function mainStartTicks(): Promise<number> {
  const own = await readProcStat(process.pid)
  return own && own !== 'gone' ? own.startTicks : 0
}

function kill(target: number): void {
  try {
    process.kill(target, 'SIGKILL')
  } catch {
    // Gone already; the next check proves it.
  }
}

/** Advances a key proof by one scan, killing what is left that a local stop would kill. */
async function advanceKeyProof(
  spawn: LostSpawn,
  proof: KeyProof,
  found: readonly KeyedProcess[],
  complete: boolean
): Promise<Proof> {
  let left = false
  for (const entry of found.filter((candidate) => candidate.key === spawn.key)) {
    proof.seen = true
    if (entry.pid === entry.sid) {
      // A session leader is this barrier child only if it runs what was spawned; otherwise it
      // detached into its own session (a daemon such as an ssh control master), which a local
      // stop would leave alone too.
      const runs =
        spawn.ownsGroup && entry.pid === entry.pgid ? await runsArgv(entry.pid, spawn.argv) : false
      if (runs === true) {
        return { kind: 'group', groupId: entry.pid, leaderStartTicks: entry.startTicks }
      }
      // Unreadable: it may be this child, so nothing is proven this scan.
      left ||= runs === 'unproven'
      continue
    }
    left = true
    const now = await readProcStat(entry.pid)
    if (now !== null && now !== 'gone' && now.startTicks === entry.startTicks) {
      kill(entry.pid)
    }
  }
  // A fork caught before its exec doesn't carry the key yet; a second look after it settles does.
  proof.quietScans = complete && !left ? proof.quietScans + 1 : 0
  return proof
}

/** Kills what is left of one child; true once it is proven ended. */
async function provenEnded(proof: Proof): Promise<boolean> {
  if (proof.kind === 'record') {
    return true
  }
  if (proof.kind === 'group') {
    if (proof.leaderStartTicks !== undefined) {
      const leader = await readProcStat(proof.groupId)
      if (leader === null) {
        return false
      }
      // A different process now has the leader's id: it could only get it once the group was gone.
      if (leader !== 'gone' && leader.startTicks !== proof.leaderStartTicks) {
        return true
      }
    }
    const live = await groupHasLiveMember(proof.groupId)
    if (live !== false) {
      kill(-proof.groupId)
    }
    return live === false
  }
  if (proof.kind === 'root') {
    const current = await readProcStat(proof.pid)
    if (current === null) {
      // Unreadable proves nothing, and an unverified pid is never signalled.
      return false
    }
    if (current === 'gone' || current.startTicks !== proof.startTicks || current.state === 'Z') {
      return true
    }
    kill(proof.pid)
    return false
  }
  return proof.quietScans >= 2
}

/**
 * Linux: the launcher that started these children is gone, and with it every pid and exit it had
 * not yet reported. Each child is ended the way a local stop would end it, from the launcher's
 * record of it: a barrier child's group until no live member is left, any other child's root
 * matched by pid and start time so a reused pid is never hit. A child without a record is found
 * by its key, or, before its exec, as a fork still running the launcher's own command line. `onEnded` hears each child as soon as it alone is proven ended, so one that can't
 * be ended (stuck in the kernel) holds only its own caller, as it would today.
 */
export async function endLostSpawns(
  spawns: readonly LostSpawn[],
  recordDir: string | null,
  launcher: LostLauncher | null,
  onEnded: (key: string, pid: number | undefined, started: boolean) => void
): Promise<void> {
  const open = new Map<string, { spawn: LostSpawn; record: RecordRead; proof?: Proof }>()
  for (const spawn of spawns) {
    open.set(spawn.key, { spawn, record: await readSpawnRecord(recordDir, spawn.key) })
  }
  let scan: ReturnType<typeof createKeyScan> | null = null
  let delayMs = FIRST_CHECK_MS
  while (open.size > 0) {
    for (const entry of open.values()) {
      if (entry.record === 'unreadable') {
        entry.record = await readSpawnRecord(recordDir, entry.spawn.key)
      }
      if (entry.record !== 'unreadable') {
        entry.proof ??= proofFor(entry.spawn, entry.record, recordDir)
      }
    }
    const byKey = [...open.values()].flatMap((entry) =>
      entry.proof?.kind === 'key' ? [{ entry, proof: entry.proof }] : []
    )
    if (byKey.length > 0) {
      scan ??= createKeyScan(
        SPAWN_KEY_ENV,
        new Set(spawns.map((spawn) => spawn.key)),
        // Its children started after it; with no launcher (in main), after main. Both clock-free.
        launcher?.startTicks ?? (await mainStartTicks()),
        launcher
      )
      const { found, forks, complete } = await scan()
      // A fork not yet exec'd may become any of these children, so none is quiet while one lives.
      for (const fork of forks) {
        const now = await readProcStat(fork.pid)
        if (now !== null && now !== 'gone' && now.startTicks === fork.startTicks) {
          kill(fork.pid)
        }
      }
      for (const { entry, proof } of byKey) {
        entry.proof = await advanceKeyProof(
          entry.spawn,
          proof,
          found,
          complete && forks.length === 0
        )
      }
    }
    let progressed = false
    for (const [key, entry] of open) {
      if (entry.proof && (await provenEnded(entry.proof))) {
        open.delete(key)
        progressed = true
        const { spawn, proof, record } = entry
        const pid =
          typeof record === 'object'
            ? record.pid
            : proof.kind === 'group'
              ? proof.groupId
              : spawn.pid
        const started =
          pid !== undefined ||
          (proof.kind === 'record' ? spawn.recorded : proof.kind !== 'key' || proof.seen)
        onEnded(key, pid, started)
      }
    }
    if (open.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs).unref?.())
      delayMs = progressed ? FIRST_CHECK_MS : Math.min(delayMs * 2, MAX_CHECK_MS)
    }
  }
  if (recordDir) {
    await rm(recordDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

// Long enough that another Orca still ending its lost launcher's children has read its records.
const ORPHANED_RECORDS_MIN_AGE_MS = 60 * 60_000

/** Records left by launchers whose process is gone, such as after main itself crashed. */
export async function pruneOrphanedSpawnRecords(): Promise<void> {
  const uid = process.getuid?.()
  if (uid === undefined) {
    return
  }
  for (const base of privateRuntimeDirectoryCandidates(SPAWN_RECORDS_DIR_NAME, uid)) {
    try {
      const st = await lstat(base)
      if (!st.isDirectory() || st.uid !== uid) {
        continue
      }
      for (const name of await readdir(base)) {
        const dir = join(base, name)
        const owner = /^(\d+)-\d+$/.exec(name)?.[1]
        if (
          owner !== undefined &&
          !processExists(Number(owner)) &&
          Date.now() - (await lstat(dir)).mtimeMs > ORPHANED_RECORDS_MIN_AGE_MS
        ) {
          await rm(dir, { recursive: true, force: true })
        }
      }
    } catch {
      // Nothing there, or nothing removable.
    }
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return errorCode(error) !== 'ESRCH'
  }
}
