import { lstat, readdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { processGroupExists } from '@orca/process-host/process-tree-termination'
import { privateRuntimeDirectoryCandidates } from '../filesystem/private-runtime-directory'

/** Every child the isolated spawner starts carries its own value; its descendants inherit it. */
export const SPAWN_KEY_ENV = 'ORCA_SPAWN_KEY'
export const SPAWN_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export const SPAWN_RECORDS_DIR_NAME = 'orca-spawns'

const FIRST_CHECK_MS = 50
const MAX_CHECK_MS = 30_000
// Main's descriptors and threadpool serve everything else it does; a scan must not exhaust them.
const MAX_CONCURRENT_READS = 16
// /proc reports start times in USER_HZ ticks, 100 on every Linux Orca runs on; the margin covers rounding.
const TICKS_PER_SECOND = 100
const START_MARGIN_TICKS = 2 * TICKS_PER_SECOND

export type LostSpawn = {
  key: string
  /** The pid main heard, if any. */
  pid?: number
  /** Main heard that the launcher recorded this child. */
  recorded: boolean
  /** Started as its own process group and session (a termination barrier): the group must end. */
  ownsGroup: boolean
  spawnedAtMs: number
}

type ProcStat = { pgid: number; sid: number; startTicks: number }

export function parseProcStat(text: string): ProcStat | null {
  // Fields after the command name, which may itself contain spaces and parentheses.
  const fields = text.slice(text.lastIndexOf(')') + 2).split(' ')
  const [pgid, sid, startTicks] = [Number(fields[2]), Number(fields[3]), Number(fields[19])]
  return Number.isInteger(pgid) && Number.isInteger(sid) && Number.isInteger(startTicks)
    ? { pgid, sid, startTicks }
    : null
}

async function readProcStat(pid: number): Promise<ProcStat | null> {
  try {
    return parseProcStat(await readFile(`/proc/${pid}/stat`, 'latin1'))
  } catch {
    return null
  }
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
}

/** Only a process being gone, or not ours, proves a failed read found nothing. */
function readFailureProvesNothing(error: unknown): boolean {
  const code = errorCode(error)
  return code !== 'ENOENT' && code !== 'ESRCH' && code !== 'EACCES' && code !== 'EPERM'
}

async function inBatches<T>(items: readonly T[], run: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      await run(items[next++])
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_READS, items.length) }, lane))
}

type KeyedProcess = ProcStat & { pid: number; key: string }

/**
 * Processes carrying one of `keys`. Reading a process's environment can wait on its memory lock,
 * so only this user's processes started since the earliest spawn are read, and a read still
 * pending from an earlier scan is never issued again: that scan just stays unproven.
 */
function createKeyScan(keys: ReadonlySet<string>, sinceTicks: number) {
  const uid = process.getuid?.()
  const pending = new Set<number>()
  return async (): Promise<{ found: KeyedProcess[]; complete: boolean }> => {
    const found: KeyedProcess[] = []
    let entries: string[]
    try {
      entries = await readdir('/proc')
    } catch {
      return { found, complete: false }
    }
    let complete = pending.size === 0
    const readOne = async (pid: number): Promise<void> => {
      try {
        if ((await stat(`/proc/${pid}`)).uid !== uid) {
          return
        }
      } catch (error) {
        complete &&= !readFailureProvesNothing(error)
        return
      }
      const procStat = await readProcStat(pid)
      if (!procStat || procStat.startTicks < sinceTicks) {
        return
      }
      if (pending.has(pid)) {
        complete = false
        return
      }
      pending.add(pid)
      let environ: string
      try {
        environ = await readFile(`/proc/${pid}/environ`, 'latin1')
      } catch (error) {
        complete &&= !readFailureProvesNothing(error)
        return
      } finally {
        pending.delete(pid)
      }
      const variable = environ.split('\0').find((entry) => entry.startsWith(`${SPAWN_KEY_ENV}=`))
      const key = variable?.slice(SPAWN_KEY_ENV.length + 1)
      if (key && keys.has(key)) {
        found.push({ ...procStat, pid, key })
      }
    }
    await inBatches(entries.filter((entry) => /^\d+$/.test(entry)).map(Number), readOne)
    return { found, complete }
  }
}

async function readSpawnRecord(
  dir: string,
  key: string
): Promise<{ pid: number; startTicks: number } | undefined> {
  try {
    const [pid, startTicks] = (await readFile(join(dir, key), 'utf8')).split(' ').map(Number)
    return Number.isInteger(pid) && pid > 0 && Number.isInteger(startTicks)
      ? { pid, startTicks }
      : undefined
  } catch {
    return undefined
  }
}

function signal(target: number): void {
  try {
    process.kill(target, 'SIGKILL')
  } catch {
    // Gone already; the next check proves it.
  }
}

/** The start time /proc would give a process started at `atMs`, less a margin. */
async function ticksAt(atMs: number): Promise<number> {
  try {
    const uptimeSeconds = Number((await readFile('/proc/uptime', 'latin1')).split(' ')[0])
    return (
      Math.floor((uptimeSeconds - (Date.now() - atMs) / 1000) * TICKS_PER_SECOND) -
      START_MARGIN_TICKS
    )
  } catch {
    return 0
  }
}

/**
 * Linux: the launcher that started these children is gone, and with it every pid and exit it had
 * not yet reported. Each child is ended the way a local stop would end it, from the launcher's
 * record: a barrier child's whole group must be gone; any other child's root, matched by pid and
 * start time so a reused pid is never hit, must be gone. A record is removed only once its child
 * has ended, so a missing one means the child ended, unless main never heard it was recorded:
 * then the child is found by its key, and processes that detached into their own session
 * (daemons such as an ssh control master) are left alone as a local stop would leave them.
 * Resolves with the pid (or undefined, when only its key proved it) of each child that started.
 */
export async function endLostSpawns(
  spawns: readonly LostSpawn[],
  recordDir: string | null
): Promise<Map<string, number | undefined>> {
  const started = new Map<string, number | undefined>()
  const groups = new Map<string, number>()
  const roots = new Map<string, { pid: number; startTicks: number }>()
  const unrecorded: LostSpawn[] = []
  for (const spawn of spawns) {
    const record = recordDir ? await readSpawnRecord(recordDir, spawn.key) : undefined
    if (record) {
      started.set(spawn.key, record.pid)
      if (spawn.ownsGroup) {
        groups.set(spawn.key, record.pid)
      } else {
        roots.set(spawn.key, record)
      }
    } else if (recordDir && spawn.recorded) {
      started.set(spawn.key, spawn.pid)
    } else {
      unrecorded.push(spawn)
      if (spawn.pid !== undefined) {
        started.set(spawn.key, spawn.pid)
      }
    }
  }
  const scan =
    unrecorded.length > 0
      ? createKeyScan(
          new Set(unrecorded.map((spawn) => spawn.key)),
          await ticksAt(Math.min(...unrecorded.map((spawn) => spawn.spawnedAtMs)))
        )
      : null
  const ownsGroup = new Set(unrecorded.filter((spawn) => spawn.ownsGroup).map((spawn) => spawn.key))
  const groupsEnded = new Set<string>()
  let delayMs = FIRST_CHECK_MS
  // A fork caught before its exec doesn't carry the key yet; a second look after it settles does.
  let quietRounds = 0
  while (spawns.length > 0 && quietRounds < 2) {
    const result = scan ? await scan() : { found: [], complete: true }
    let keyedLeft = false
    const byStart = [...result.found].sort((a, b) => a.startTicks - b.startTicks)
    for (const found of byStart) {
      if (!started.has(found.key)) {
        started.set(found.key, undefined)
      }
      if (found.pid === found.sid) {
        // The first session leader carrying a barrier child's key is that child; later ones detached.
        if (ownsGroup.has(found.key) && !groups.has(found.key) && !groupsEnded.has(found.key)) {
          groups.set(found.key, found.pid)
          started.set(found.key, found.pid)
        }
        continue
      }
      keyedLeft = true
      if ((await readProcStat(found.pid))?.startTicks === found.startTicks) {
        signal(found.pid)
      }
    }
    for (const groupId of groups.values()) {
      signal(-groupId)
    }
    for (const [key, root] of roots) {
      if ((await readProcStat(root.pid))?.startTicks === root.startTicks) {
        signal(root.pid)
      } else {
        roots.delete(key)
      }
    }
    for (const [key, groupId] of groups) {
      if (!processGroupExists(groupId)) {
        // Proven gone: its id may be reused from now on, so it is never signalled again.
        groups.delete(key)
        groupsEnded.add(key)
      }
    }
    const quiet = result.complete && !keyedLeft && groups.size === 0 && roots.size === 0
    quietRounds = quiet ? quietRounds + 1 : 0
    if (quietRounds < 2) {
      await new Promise((resolve) => setTimeout(resolve, delayMs).unref?.())
      delayMs = quiet ? FIRST_CHECK_MS : Math.min(delayMs * 2, MAX_CHECK_MS)
    }
  }
  if (recordDir) {
    await rm(recordDir, { recursive: true, force: true }).catch(() => undefined)
  }
  return started
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
