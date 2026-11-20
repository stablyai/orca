import { readdir, readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { processGroupExists } from '@orca/process-host/process-tree-termination'

// Main's descriptors and threadpool serve everything else it does; a scan must not exhaust them.
const MAX_CONCURRENT_READS = 16
// /proc reports start times in USER_HZ ticks, 100 on every Linux Orca runs on; the margin covers rounding.
const TICKS_PER_SECOND = 100
const START_MARGIN_TICKS = 2 * TICKS_PER_SECOND

export type ProcStat = { state: string; pgid: number; sid: number; startTicks: number }

/** /proc/<pid>/stat; unlike environ or cmdline, reading it never waits on the process's memory lock. */
export function parseProcStat(text: string): ProcStat | null {
  // Fields after the command name, which may itself contain spaces and parentheses.
  const fields = text.slice(text.lastIndexOf(')') + 2).split(' ')
  const [pgid, sid, startTicks] = [Number(fields[2]), Number(fields[3]), Number(fields[19])]
  return fields[0] &&
    Number.isInteger(pgid) &&
    Number.isInteger(sid) &&
    Number.isInteger(startTicks)
    ? { state: fields[0], pgid, sid, startTicks }
    : null
}

/** 'gone' only when the process no longer exists; null when its state couldn't be read. */
export async function readProcStat(pid: number): Promise<ProcStat | 'gone' | null> {
  try {
    return parseProcStat(await readFile(`/proc/${pid}/stat`, 'latin1'))
  } catch (error) {
    return readFailureProvesNothing(error) ? null : 'gone'
  }
}

export function errorCode(error: unknown): unknown {
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

async function procPids(): Promise<number[] | null> {
  try {
    return (await readdir('/proc')).filter((entry) => /^\d+$/.test(entry)).map(Number)
  } catch {
    return null
  }
}

/** True while the group has a member that is not a zombie; null when that can't be read. */
export async function groupHasLiveMember(groupId: number): Promise<boolean | null> {
  if (!processGroupExists(groupId)) {
    return false
  }
  const pids = await procPids()
  if (!pids) {
    return null
  }
  let live: boolean | null = false
  await inBatches(pids, async (pid) => {
    const procStat = await readProcStat(pid)
    if (procStat === null) {
      live = live === true ? true : null
    } else if (procStat !== 'gone' && procStat.pgid === groupId && procStat.state !== 'Z') {
      live = true
    }
  })
  return live
}

/** The start time /proc would give a process started at `at` (performance.now()), less a margin. */
export async function ticksAt(at: number): Promise<number> {
  try {
    const uptimeSeconds = Number((await readFile('/proc/uptime', 'latin1')).split(' ')[0])
    return (
      Math.floor((uptimeSeconds - (performance.now() - at) / 1000) * TICKS_PER_SECOND) -
      START_MARGIN_TICKS
    )
  } catch {
    return 0
  }
}

export type KeyedProcess = ProcStat & { pid: number; key: string }

const SLOW = Symbol('slow')
const SLOW_READ_MS = 1_000

function slowAfter(ms: number): Promise<typeof SLOW> {
  return new Promise((resolve) => setTimeout(() => resolve(SLOW), ms).unref?.())
}

/**
 * Live processes whose environment carries `keyEnv`=one of `keys`. Reading a process's
 * environment can wait on its memory lock, so only this user's processes started since
 * `sinceTicks` are read, and a read still pending from an earlier scan is never issued again:
 * that scan just stays unproven.
 */
export function createKeyScan(keyEnv: string, keys: ReadonlySet<string>, sinceTicks: number) {
  const uid = process.getuid?.()
  const pending = new Set<number>()
  return async (): Promise<{ found: KeyedProcess[]; complete: boolean }> => {
    const found: KeyedProcess[] = []
    const pids = await procPids()
    if (!pids) {
      return { found, complete: false }
    }
    let complete = pending.size === 0
    await inBatches(pids, async (pid) => {
      try {
        if ((await stat(`/proc/${pid}`)).uid !== uid) {
          return
        }
      } catch (error) {
        complete &&= !readFailureProvesNothing(error)
        return
      }
      const procStat = await readProcStat(pid)
      if (procStat === null) {
        complete = false
        return
      }
      if (procStat === 'gone' || procStat.state === 'Z' || procStat.startTicks < sinceTicks) {
        return
      }
      if (pending.has(pid)) {
        complete = false
        return
      }
      pending.add(pid)
      const read = readFile(`/proc/${pid}/environ`, 'latin1').finally(() => pending.delete(pid))
      let environ: string | typeof SLOW
      try {
        environ = await Promise.race([read, slowAfter(SLOW_READ_MS)])
      } catch (error) {
        complete &&= !readFailureProvesNothing(error)
        return
      }
      if (environ === SLOW) {
        // Left to finish on its own; this scan stays unproven, and other children's proofs go on.
        read.catch(() => undefined)
        complete = false
        return
      }
      const variable = environ.split('\0').find((entry) => entry.startsWith(`${keyEnv}=`))
      const key = variable?.slice(keyEnv.length + 1)
      if (key && keys.has(key)) {
        found.push({ ...procStat, pid, key })
      }
    })
    return { found, complete }
  }
}

/** Whether `pid` runs exactly `argv` (its program compared by name, as PATH may resolve it). */
export async function runsArgv(pid: number, argv: readonly string[]): Promise<boolean> {
  try {
    const running = (await readFile(`/proc/${pid}/cmdline`, 'latin1')).split('\0').slice(0, -1)
    return (
      running.length === argv.length &&
      basename(running[0] ?? '') === basename(argv[0] ?? '') &&
      running.slice(1).every((arg, index) => arg === argv[index + 1])
    )
  } catch {
    return false
  }
}
