// Orca's own processes on Linux for the memory soak: which processes belong to one copy, and one trusted sample.
import fs from 'node:fs'

// A process that vanished mid-read; other read errors are judged by whether the process was already counted.
const GONE = new Set(['ENOENT', 'ESRCH'])

const readOrNull = (read) => {
  try {
    return read()
  } catch (error) {
    if (GONE.has(error?.code)) {
      return null
    }
    throw error
  }
}

/** The /proc reads the census and sampler need; a test swaps in a fake table to inject faults. */
export const linuxProc = {
  pids: () =>
    fs
      .readdirSync('/proc')
      .filter((entry) => /^\d+$/.test(entry))
      .map(Number),
  /** Parent, state and start time, or null once the process is gone. */
  stat: (pid) =>
    readOrNull(() => {
      const text = fs.readFileSync(`/proc/${String(pid)}/stat`, 'utf8')
      // The command name can hold spaces and parens, so fields are read after its closing paren.
      const fields = text.slice(text.lastIndexOf(')') + 2).split(' ')
      return { state: fields[0], ppid: Number(fields[1]), start: fields[19] }
    }),
  /** The executable's path, or null once the process is gone. */
  exe: (pid) => readOrNull(() => fs.readlinkSync(`/proc/${String(pid)}/exe`)),
  /** Whether the process's environment holds this entry, or null once the process is gone. */
  hasEnv: (pid, entry) =>
    readOrNull(() =>
      fs
        .readFileSync(`/proc/${String(pid)}/environ`, 'utf8')
        .split('\0')
        .includes(entry)
    ),
  /** Proportional set size plus swapped share in MB, or null once the process is gone. */
  pssMb: (pid) =>
    readOrNull(() => {
      const rollup = fs.readFileSync(`/proc/${String(pid)}/smaps_rollup`, 'utf8')
      const kb = (field) =>
        Number(new RegExp(`^${field}:\\s+(\\d+)`, 'm').exec(rollup)?.[1] ?? Number.NaN)
      const mb = (kb('Pss') + (kb('SwapPss') || 0)) / 1024
      if (!Number.isFinite(mb)) {
        throw Object.assign(new Error(`no Pss for ${String(pid)}`), { code: 'ENODATA' })
      }
      return mb
    })
}

export class CensusUnsure extends Error {}

/**
 * Orca's own processes Electron doesn't list, for one copy: those running its Electron binary (the terminal
 * daemon, which hosts the chat relays, and other Node children) and each chat's native provider processes
 * (`orca-provider-exec` from its app folder: supervisor and watcher). A process with one of those executables is
 * this copy's when its parent chain reaches main, or, when its parent exited or its parent pid was reused
 * mid-scan, when it carries the copy's own HOME; another copy of the same build fails both and is skipped.
 * Orca never makes its processes undumpable, so a process never counted that answers EACCES isn't Orca's
 * (e.g. a same-user ssh-agent) and is skipped; any other read error leaves the census unsure. So does a read
 * error on a counted process (same pid and start time), or a counted process still running but no longer
 * matched (CensusUnsure).
 */
export class LinuxOrcaCensus {
  constructor(proc = linuxProc) {
    this.proc = proc
    this.known = new Map()
  }

  live(pid) {
    const stat = this.proc.stat(pid)
    return stat !== null && stat.state !== 'Z' ? stat : null
  }

  /** One /proc read: an error on a counted process, or any error but EACCES, makes the census unsure. */
  read(pid, read) {
    try {
      return read()
    } catch (error) {
      // Counted means the same process as before: a pid reused by another process is judged as a new one.
      const knownStart = this.known.get(pid)
      if (knownStart !== undefined) {
        let current
        try {
          current = this.proc.stat(pid)
        } catch {
          current = undefined
        }
        if (current === undefined || current?.start === knownStart) {
          throw new CensusUnsure(
            `counted process ${String(pid)} unreadable: ${String(error?.code ?? error)}`
          )
        }
      }
      // Permission denied is how Linux answers for an undumpable process, which Orca never is; any other error
      // could hide one of Orca's own, so it leaves the census unsure.
      if (error?.code === 'EACCES') {
        return null
      }
      throw new CensusUnsure(`process ${String(pid)} unreadable: ${String(error?.code ?? error)}`)
    }
  }

  /** This copy's unlisted processes as { pid, type, start }. */
  discover({ mainPid, listed, appPath, home }) {
    const electronExe = this.live(mainPid) ? this.proc.exe(mainPid) : null
    if (!electronExe) {
      throw new CensusUnsure(`main ${String(mainPid)} is not readable`)
    }
    const stats = new Map()
    for (const pid of this.proc.pids()) {
      const stat = this.read(pid, () => this.proc.stat(pid))
      if (stat !== null && stat.state !== 'Z') {
        stats.set(pid, stat)
      }
    }
    const reachesMain = (pid) => {
      const seen = new Set()
      for (let at = pid; at !== undefined && !seen.has(at); at = stats.get(at)?.ppid) {
        if (at === mainPid) {
          return true
        }
        seen.add(at)
      }
      return false
    }
    const found = new Map()
    for (const [pid, stat] of stats) {
      if (pid === mainPid || listed.has(pid)) {
        continue
      }
      const path = this.read(pid, () => this.proc.exe(pid))
      const type =
        path === null
          ? null
          : path === electronExe
            ? 'Node'
            : path.startsWith(`${appPath}/`) &&
                path.split('/').pop().startsWith('orca-provider-exec')
              ? 'ProviderExec'
              : null
      if (!type) {
        continue
      }
      if (reachesMain(pid)) {
        found.set(pid, { type, start: stat.start })
        continue
      }
      const marked = this.read(pid, () => this.proc.hasEnv(pid, `HOME=${home}`))
      if (marked) {
        found.set(pid, { type, start: stat.start })
      }
    }
    for (const [pid, start] of this.known) {
      if (found.has(pid) || listed.has(pid)) {
        continue
      }
      if (this.live(pid)?.start === start) {
        throw new CensusUnsure(`Orca process ${String(pid)} is still running but no longer matches`)
      }
      this.known.delete(pid)
    }
    for (const [pid, { start }] of found) {
      this.known.set(pid, start)
    }
    return [...found].map(([pid, entry]) => ({ pid, ...entry }))
  }
}

/**
 * One sample: listed processes plus the census, each read for memory and then checked to be the same process
 * (start time) as when it was found, so a pid freed and reused mid-sample can't stand in for an Orca process.
 * Null with a reason when the sample can't be trusted.
 */
export function measureSample({ proc = linuxProc, census, mainPid, appPath, home, metrics }) {
  const listed = new Set(metrics.map(({ pid }) => pid))
  let processes
  try {
    const found = census.discover({ mainPid, listed, appPath, home })
    processes = [
      ...metrics.map(({ pid, type }) => ({ pid, type, start: proc.stat(pid)?.start })),
      ...found
    ]
  } catch (error) {
    if (error instanceof CensusUnsure || (error?.code && !GONE.has(error.code))) {
      return { dropped: String(error.message) }
    }
    throw error
  }
  const byType = {}
  let total = 0
  for (const entry of processes) {
    let mb
    try {
      mb = entry.start === undefined ? null : proc.pssMb(entry.pid)
    } catch (error) {
      return {
        dropped: `memory of ${String(entry.pid)} unreadable: ${String(error?.code ?? error)}`
      }
    }
    if (mb === null || proc.stat(entry.pid)?.start !== entry.start) {
      return { dropped: `process ${String(entry.pid)} exited or was replaced mid-sample` }
    }
    byType[entry.type] = (byType[entry.type] ?? 0) + mb
    total += mb
  }
  return {
    sample: {
      totalMb: Math.round(total),
      processes: processes.length,
      processSet: processes
        .map(({ pid, start }) => `${String(pid)}@${String(start)}`)
        .sort()
        .join(','),
      mainPid,
      byType: Object.fromEntries(Object.entries(byType).map(([type, mb]) => [type, Math.round(mb)]))
    }
  }
}

/**
 * The lowest of a checkpoint's samples, counting only samples whose process set (pid and start time) matches
 * the sample before or after: a process that started, exited or was replaced inside one scan can't make that
 * scan the low one.
 */
export function stableLowest(samples) {
  let lowest = null
  samples.forEach((sample, index) => {
    const steady = [samples[index - 1], samples[index + 1]].some(
      (neighbour) => neighbour?.processSet === sample.processSet
    )
    if (steady && (lowest === null || sample.totalMb < lowest.totalMb)) {
      lowest = sample
    }
  })
  return lowest
}
