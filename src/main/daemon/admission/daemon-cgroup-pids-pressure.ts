import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { HostPressureLevel } from '../../../shared/terminal/pty/admission/spawn-admission-contract'

const CGROUP_ROOT = '/sys/fs/cgroup'
const CRITICAL_RATIO = 0.9
const RECOVER_RATIO = 0.8
// Decisions start a background re-read at most this often; they never wait for it.
const READ_INTERVAL_MS = 1_000
// A critical reading nobody has refreshed for this long is stale and must not keep deferring spawns.
const STALE_CRITICAL_MS = 3_000

export type CgroupPidsUsage = { current: number; max: number; cgroup: string }

type ReadText = (path: string) => Promise<string>

async function readCount(readText: ReadText, path: string): Promise<number | null> {
  try {
    const value = Number.parseInt((await readText(path)).trim(), 10)
    return Number.isSafeInteger(value) && value >= 0 ? value : null
  } catch {
    return null
  }
}

function pidsCgroupDirectory(
  procCgroup: string
): { directory: string; boundary: string; cgroup: string } | null {
  for (const line of procCgroup.split('\n')) {
    const [hierarchy, controllers, ...rest] = line.split(':')
    const cgroup = rest.join(':').replace(/ \(deleted\)$/, '')
    if (!cgroup.startsWith('/')) {
      continue
    }
    if (hierarchy === '0' && controllers === '') {
      return { directory: join(CGROUP_ROOT, cgroup), boundary: CGROUP_ROOT, cgroup }
    }
    if (controllers?.split(',').includes('pids')) {
      const boundary = join(CGROUP_ROOT, 'pids')
      return { directory: join(boundary, cgroup), boundary, cgroup }
    }
  }
  return null
}

/** The most-used numeric pids limit across the daemon's cgroup and its ancestors; null when none applies. */
export async function readCgroupPidsUsage(
  readText: ReadText = (path) => readFile(path, 'utf8'),
  platform: NodeJS.Platform = process.platform
): Promise<CgroupPidsUsage | null> {
  if (platform !== 'linux') {
    return null
  }
  let located: ReturnType<typeof pidsCgroupDirectory>
  try {
    located = pidsCgroupDirectory(await readText('/proc/self/cgroup'))
  } catch {
    return null
  }
  if (!located) {
    return null
  }
  let tightest: CgroupPidsUsage | null = null
  for (let directory = located.directory; ; directory = dirname(directory)) {
    const max = await readCount(readText, join(directory, 'pids.max'))
    const current = await readCount(readText, join(directory, 'pids.current'))
    // A literal `max` is unlimited and fails to parse, so only numeric limits count.
    if (max !== null && max > 0 && current !== null) {
      if (tightest === null || current / max > tightest.current / tightest.max) {
        tightest = { current, max, cgroup: directory.slice(located.boundary.length) || '/' }
      }
    }
    if (directory === located.boundary || directory === dirname(directory)) {
      return tightest
    }
  }
}

type CgroupPidsPressureOptions = {
  log: (event: string, details: Record<string, unknown>) => void
  /** Called after a background re-read changes the level, never from inside a spawn decision. */
  onLevelChanged: (level: HostPressureLevel) => void
  read?: () => Promise<CgroupPidsUsage | null>
  now?: () => number
}

/** Reports `critical` as the daemon nears a cgroup pids limit; unreadable or unlimited means `ok`, including the first decision before any reading. */
export class CgroupPidsPressure {
  private current: HostPressureLevel = 'ok'
  private checkedAt = Number.NEGATIVE_INFINITY
  private inflight: Promise<void> | null = null
  private readonly read: () => Promise<CgroupPidsUsage | null>
  private readonly now: () => number

  constructor(private readonly options: CgroupPidsPressureOptions) {
    this.read = options.read ?? (() => readCgroupPidsUsage())
    this.now = options.now ?? Date.now
  }

  /** Synchronous for the spawn gate: returns the latest reading and starts a re-read when it is old. */
  get level(): HostPressureLevel {
    const age = this.now() - this.checkedAt
    // A clock that jumped back makes the age negative; treat that as old, never as fresh.
    const old = age < 0 || age >= READ_INTERVAL_MS
    if (!this.inflight && old) {
      void this.refresh()
    }
    return this.current === 'critical' && (age < 0 || age > STALE_CRITICAL_MS) ? 'ok' : this.current
  }

  refresh(): Promise<void> {
    this.inflight ??= this.readOnce().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private async readOnce(): Promise<void> {
    let usage: CgroupPidsUsage | null = null
    try {
      usage = await this.read()
    } catch {
      // Fail open: an unreadable limit must never block a spawn.
    }
    this.checkedAt = this.now()
    const ratio = usage ? usage.current / usage.max : 0
    const next: HostPressureLevel =
      ratio >= CRITICAL_RATIO || (this.current === 'critical' && ratio >= RECOVER_RATIO)
        ? 'critical'
        : 'ok'
    if (next === this.current) {
      return
    }
    this.current = next
    try {
      this.options.log('cgroup-pids-level', {
        level: next,
        current: usage?.current ?? null,
        max: usage?.max ?? null,
        cgroup: usage?.cgroup ?? null
      })
      this.options.onLevelChanged(next)
    } catch {
      // Diagnostics and waiter wake-ups must never fail a read.
    }
  }
}

/** Startup record of the limit that can kill the daemon, with the knob that raises it. */
export async function logCgroupPidsLimit(
  log: (event: string, details: Record<string, unknown>) => void,
  read: () => Promise<CgroupPidsUsage | null> = () => readCgroupPidsUsage(),
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  if (platform !== 'linux') {
    return
  }
  const usage = await read().catch(() => null)
  log(
    'cgroup-pids-limit',
    usage
      ? {
          max: usage.max,
          current: usage.current,
          cgroup: usage.cgroup,
          hint: 'raise it with docker --pids-limit, compose pids_limit or systemd TasksMax'
        }
      : { max: null }
  )
}
