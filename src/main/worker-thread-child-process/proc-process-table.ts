import { readdir, readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { processGroupExists } from '@orca/process-host/process-tree-termination'

// Main's descriptors and threadpool serve everything else it does; a scan must not exhaust them.
const MAX_CONCURRENT_READS = 16

export type ProcStat = {
  state: string
  ppid: number
  pgid: number
  sid: number
  startTicks: number
}

/** /proc/<pid>/stat; unlike environ or cmdline, reading it never waits on the process's memory lock. */
export function parseProcStat(text: string): ProcStat | null {
  // Fields after the command name, which may itself contain spaces and parentheses.
  const fields = text.slice(text.lastIndexOf(')') + 2).split(' ')
  const [ppid, pgid, sid] = [Number(fields[1]), Number(fields[2]), Number(fields[3])]
  const startTicks = Number(fields[19])
  return fields[0] &&
    Number.isInteger(ppid) &&
    Number.isInteger(pgid) &&
    Number.isInteger(sid) &&
    Number.isInteger(startTicks)
    ? { state: fields[0], ppid, pgid, sid, startTicks }
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

export type KeyedProcess = ProcStat & { pid: number; key: string }

const SLOW_READ_MS = 1_000
// Reads that can wait on a memory lock hold one of main's 4 libuv threadpool threads each until
// they return; this many at most, counting abandoned slow ones, leaves the rest for main.
const MAX_OUTSTANDING_SLOW_READS = 2

/**
 * Reads /proc/<pid>/<file> where the read can wait on the process's memory lock. A read is never
 * issued twice for one pid nor past the outstanding cap, and one still running after a second is
 * left to finish on its own; each of those answers 'unproven' instead.
 */
function createGuardedReader() {
  const outstanding = new Set<number>()
  return async (pid: number, file: string): Promise<string | 'unproven' | 'none'> => {
    if (outstanding.has(pid) || outstanding.size >= MAX_OUTSTANDING_SLOW_READS) {
      return 'unproven'
    }
    outstanding.add(pid)
    const read = readFile(`/proc/${pid}/${file}`, 'latin1').finally(() => outstanding.delete(pid))
    read.catch(() => undefined)
    try {
      const result = await Promise.race([
        read,
        new Promise<'unproven'>((resolve) =>
          setTimeout(() => resolve('unproven'), SLOW_READ_MS).unref?.()
        )
      ])
      return result === 'unproven' ? 'unproven' : result
    } catch (error) {
      return readFailureProvesNothing(error) ? 'unproven' : 'none'
    }
  }
}

/**
 * Live processes of this user started since `sinceTicks` whose environment carries `keyEnv`=one
 * of `keys`, and (`forks`) the launcher's children that haven't exec'd yet: they still show its
 * command line, which is unique (Chromium gives each utility process its own trace id).
 */
export function createKeyScan(
  keyEnv: string,
  keys: ReadonlySet<string>,
  sinceTicks: number,
  launcher: { pid: number; cmdline: string } | null
) {
  const uid = process.getuid?.()
  const read = createGuardedReader()
  return async (): Promise<{
    found: KeyedProcess[]
    forks: KeyedProcess[]
    complete: boolean
  }> => {
    const found: KeyedProcess[] = []
    const forks: KeyedProcess[] = []
    const pids = await procPids()
    if (!pids) {
      return { found, forks, complete: false }
    }
    let complete = true
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
      const environ = await read(pid, 'environ')
      if (environ === 'unproven') {
        complete = false
        return
      }
      const variable =
        environ === 'none'
          ? undefined
          : environ.split('\0').find((entry) => entry.startsWith(`${keyEnv}=`))
      const key = variable?.slice(keyEnv.length + 1)
      if (key && keys.has(key)) {
        found.push({ ...procStat, pid, key })
        return
      }
      if (
        key ||
        environ === 'none' ||
        !launcher ||
        pid === launcher.pid ||
        procStat.ppid === process.pid
      ) {
        return
      }
      const cmdline = await read(pid, 'cmdline')
      if (cmdline === 'unproven') {
        complete = false
      } else if (cmdline === launcher.cmdline) {
        forks.push({ ...procStat, pid, key: '' })
      }
    })
    return { found, forks, complete }
  }
}

/**
 * Whether `pid` runs `argv`: its command line ends with the spawned arguments and names the
 * spawned program, compared by name since PATH may resolve it and an interpreter (a script's
 * `#!` line) may run it.
 */
export async function runsArgv(pid: number, argv: readonly string[]): Promise<boolean> {
  try {
    const running = (await readFile(`/proc/${pid}/cmdline`, 'latin1')).split('\0').slice(0, -1)
    const args = argv.slice(1)
    const head = running.slice(0, running.length - args.length)
    return (
      head.length > 0 &&
      running.slice(head.length).every((arg, index) => arg === args[index]) &&
      head.some((arg) => basename(arg) === basename(argv[0] ?? ''))
    )
  } catch {
    return false
  }
}
