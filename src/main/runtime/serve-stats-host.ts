import { readFileSync } from 'node:fs'
import os from 'node:os'
import type { HostAvailableMemorySource } from '../../shared/process-stats-types'
import type { RuntimeServeStatsHost, RuntimeServeStatsHostPids } from '../../shared/runtime-types'
import { parseLinuxAvailableMemory } from '../memory/host-memory'

// Why: `serve stats` must stay cheap enough to poll, so this reader is deliberately NOT
// `collectMemorySnapshot` (which sweeps the whole process table via `ps`) and never spawns a
// subprocess. It is `node:os` syscalls plus, on Linux only, one read of the memory-backed
// `/proc/meminfo` — a ~1.5 KiB procfs read with no disk I/O behind it — and two ~8 byte reads of
// the equally memory-backed cgroup `pids.*` files, which is why it is synchronous rather than an
// await the caller has to sequence.

const KIB = 1024

/** Injection seam so the Windows-shaped (unmeasurable) path is testable on a Linux host. */
export type ServeStatsHostSources = {
  platform?: NodeJS.Platform
  loadAverage?: () => readonly number[]
  cpuCoreCount?: () => number
  totalMemoryBytes?: () => number
  freeMemoryBytes?: () => number
  /** Raw `/proc/meminfo` text, or null when procfs is unreadable here. */
  readMeminfo?: () => string | null
  /** Raw `/proc/self/cgroup` text, or null when procfs is unreadable here. */
  readSelfCgroup?: () => string | null
  /**
   * Raw text of one absolute cgroupfs file, or null when it does not exist — which covers cgroup
   * v1, an unmounted cgroupfs, and a cgroup with the pid controller disabled alike.
   */
  readCgroupFile?: (filePath: string) => string | null
}

export function collectServeStatsHost(sources: ServeStatsHostSources = {}): RuntimeServeStatsHost {
  const platform = sources.platform ?? process.platform
  const total = nonNegativeNumber((sources.totalMemoryBytes ?? os.totalmem)())
  const free = Math.min(total, nonNegativeNumber((sources.freeMemoryBytes ?? os.freemem)()))
  const meminfo = platform === 'linux' ? readMeminfo(sources.readMeminfo) : null
  const available = meminfo === null ? null : parseLinuxAvailableMemory(meminfo)
  // A MemAvailable below MemFree would be nonsense, and neither can exceed physical RAM.
  const availableBytes =
    available === null ? free : Math.min(total, Math.max(free, nonNegativeNumber(available)))
  const availableSource: HostAvailableMemorySource =
    available === null ? 'free-memory' : 'proc-meminfo'

  return {
    loadAverage1m: readLoadAverage1m(platform, sources.loadAverage ?? os.loadavg),
    cpuCoreCount: sources.cpuCoreCount ? sources.cpuCoreCount() : os.cpus().length,
    memoryTotalBytes: total,
    memoryAvailableBytes: availableBytes,
    memoryAvailableSource: availableSource,
    swapUsedBytes: meminfo === null ? null : parseLinuxSwapUsed(meminfo),
    pids: platform === 'linux' ? readCgroupPids(sources) : null
  }
}

/**
 * `SwapTotal - SwapFree` in bytes, or null when either line is missing.
 *
 * A host with swap disabled reports `SwapTotal: 0 kB`, which is a real measurement of zero — only
 * an unreadable or absent line is null.
 */
export function parseLinuxSwapUsed(meminfo: string): number | null {
  const total = matchMeminfoKiB(meminfo, 'SwapTotal')
  const free = matchMeminfoKiB(meminfo, 'SwapFree')
  if (total === null || free === null) {
    return null
  }
  return Math.max(0, total - free)
}

function matchMeminfoKiB(meminfo: string, field: string): number | null {
  const match = new RegExp(`^${field}:\\s*(\\d+)\\s+kB$`, 'm').exec(meminfo)
  if (!match) {
    return null
  }
  const kib = Number(match[1])
  return Number.isFinite(kib) ? kib * KIB : null
}

/**
 * cgroup v2 `pids.current` / `pids.max` for the cgroup that actually accounts this process, or null
 * when no reachable cgroup exposes the pid controller.
 *
 * NOT a fixed read of `/sys/fs/cgroup/pids.current`: the kernel omits controller files from the
 * root cgroup, so that path exists only in a container whose own cgroup is the mount root. On a
 * systemd host the numbers live in the unit's cgroup — measured here, that is
 * `/sys/fs/cgroup/system.slice/…/orca-serve@factory.service/pids.max` = 16384 (systemd `TasksMax`)
 * while the root path reads nothing at all. #18789's `pids.max=4096` was exactly such a unit
 * limit, so a root-only read would report null for the one incident this field exists to show.
 * The pair is read as a unit, from the nearest enclosing cgroup that has both: `current` without
 * `max` cannot say how close to the ceiling a host is, and `max` without `current` says nothing.
 *
 * Hierarchy note: cgroup v2 evaluates limits hierarchically. When an enclosing cgroup specifies no
 * local limit (`max: null` / "max"), an ancestor cgroup may impose a limit on the broader subtree.
 * The nearest cgroup provides the local accounting scope; pairing a leaf's `current` with an ancestor's
 * `max` would misrepresent the headroom since sibling processes in the ancestor also consume that ceiling.
 */
function readCgroupPids(sources: ServeStatsHostSources): RuntimeServeStatsHostPids | null {
  const read = sources.readCgroupFile ?? readCgroupFile
  const selfCgroup = (sources.readSelfCgroup ?? readSelfCgroup)()
  if (selfCgroup === null) {
    return null
  }
  for (const directory of resolveCgroupV2Directories(selfCgroup)) {
    const rawCurrent = read(`${directory}/pids.current`)
    const rawMax = read(`${directory}/pids.max`)
    if (rawCurrent === null || rawMax === null) {
      continue
    }
    // `Number('')` is 0, so a blank file must be rejected before parsing — a 0 here would claim a
    // cgroup with nothing running in it.
    const current = rawCurrent.trim() === '' ? Number.NaN : Number(rawCurrent.trim())
    const max = parseCgroupPidsMax(rawMax)
    if (!Number.isFinite(current) || current < 0 || max === undefined) {
      continue
    }
    return { current, max }
  }
  return null
}

/**
 * Every cgroup v2 directory that could account this process, nearest first, from the `0::<path>`
 * line of `/proc/self/cgroup` up to the mount root. Empty when the process is on cgroup v1 only,
 * which has no such line.
 *
 * Nearest-first because the tightest scope with the controller enabled is the one whose ceiling a
 * `clone()` hits first; a leaf with the pid controller disabled delegates accounting to its
 * closest enabled ancestor, so walking up finds the limit that actually binds.
 */
export function resolveCgroupV2Directories(selfCgroup: string): string[] {
  const line = selfCgroup.split('\n').find((candidate) => candidate.startsWith('0::'))
  if (line === undefined) {
    return []
  }
  const root = '/sys/fs/cgroup'
  const segments = line.slice('0::'.length).split('/').filter(Boolean)
  const directories = [root]
  let current = root
  for (const segment of segments) {
    current = `${current}/${segment}`
    directories.push(current)
  }
  return directories.toReversed()
}

/**
 * `pids.max` is either a decimal ceiling or the literal `max`, which the kernel writes for "no
 * limit". The literal maps to null — reporting it as a number would mean inventing one (0 reads as
 * "no pids allowed", and Infinity is not JSON) — while `undefined` marks a value this reader does
 * not understand, so the whole `pids` reading drops rather than half-reporting.
 */
export function parseCgroupPidsMax(raw: string): number | null | undefined {
  const value = raw.trim()
  if (value === 'max') {
    return null
  }
  // Blank reads as `undefined`, never as a ceiling: `Number('')` is 0, which would report a cgroup
  // that forbids every pid.
  const parsed = value === '' ? Number.NaN : Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

function readCgroupFile(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf8')
  } catch {
    // cgroup v1, an unmounted cgroupfs, or a cgroup without the pid controller: all read as
    // "not measured here", never as a fabricated 0.
    return null
  }
}

function readSelfCgroup(): string | null {
  try {
    return readFileSync('/proc/self/cgroup', 'utf8')
  } catch {
    return null
  }
}

// Windows has no load average: Node returns [0, 0, 0] there, and reporting that would read as an
// idle host rather than as "not measurable".
function readLoadAverage1m(
  platform: NodeJS.Platform,
  loadAverage: () => readonly number[]
): number | null {
  if (platform === 'win32') {
    return null
  }
  const value = loadAverage()[0]
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : null
}

function readMeminfo(reader: (() => string | null) | undefined): string | null {
  if (reader) {
    return reader()
  }
  try {
    return readFileSync('/proc/meminfo', 'utf8')
  } catch {
    // A container without procfs must yield nulls, never fail `serve stats`.
    return null
  }
}

// Three readings need the same "unusable value reads as 0 bytes" floor, mirroring
// src/main/memory/host-memory.ts.
function nonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
}
