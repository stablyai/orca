import { readFileSync } from 'node:fs'
import type { CrashReportDetailValue } from '../../shared/crash-reporting'
import { isDaemonScopeUnit } from '../daemon/daemon-cgroup-scope'

// ─── Linux kernel OOM-kill attribution ──────────────────────────────
// Why: a Linux renderer SIGKILL (exit 9) with main surviving looks the same
// whether the kernel OOM killer (global, or a memory limit on Orca's systemd
// scope) or a userspace killer (earlyoom, systemd-oomd, a script) sent it.
// Chromium raises renderer oom_score_adj, so the kernel picks a 135 MB renderer
// over a multi-GB agent. The kernel counts every OOM kill, so a counter delta
// across the death separates the two without root.

type CrashReportDetails = Record<string, CrashReportDetailValue>

/** What Orca's cgroup leaf is; a session or terminal scope also counts unrelated siblings. */
export type LinuxCgroupLeafKind = 'orca' | 'login-session' | 'root' | 'other'

export type LinuxOomKillCounters = {
  /** Host-wide kills from /proc/vmstat (kernel 4.13+). */
  vmstatOomKill?: number
  /** Kills inside Orca main's cgroup v2 subtree (renderers included), any OOM killer kind. */
  cgroupOomKill?: number
  cgroupLeafKind?: LinuxCgroupLeafKind
  /** The terminal daemon's cgroup when it is a separate scope from Orca main's. */
  daemonCgroupPath?: string
  /** Kills inside that daemon scope: the PTY daemon and every terminal agent. */
  daemonCgroupOomKill?: number
  /** True when the daemon shares Orca main's cgroup, so `cgroupOomKill` covers agents too. */
  daemonSharesCgroup?: boolean
  /** Smallest memory.max at or above Orca's cgroup (the effective limit); undefined when unlimited. */
  cgroupMemoryMaxMB?: number
  /** Every limited cgroup at or above Orca's, deepest first. */
  memoryLimits?: LinuxCgroupMemoryLimit[]
  /** PSI `some avg10` from /proc/pressure/memory, percent. */
  memoryPressureSomeAvg10?: number
}

export type LinuxCgroupMemoryLimit = {
  dir: string
  maxMB: number
  /** memory.events.local `oom`: this cgroup's own limit was hit (5.2+), not a descendant's. */
  localOomEvents?: number
}

type FileReader = (path: string) => string | undefined

function readTextFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

let fileReader: FileReader = readTextFile
let counterPlatform: NodeJS.Platform = process.platform
let daemonPidSource: (() => number | null | undefined) | null = null
let cachedDaemon: { pid: number; cgroupPath: string } | null = null

/** Why injected: crash-reporting must not import the daemon provider graph. */
export function setLinuxOomKillDaemonPidSource(
  source: (() => number | null | undefined) | null
): void {
  daemonPidSource = source
  cachedDaemon = null
}

export function setLinuxOomKillFileReaderForTest(
  reader: FileReader | null,
  platform: NodeJS.Platform = process.platform
): void {
  fileReader = reader ?? readTextFile
  counterPlatform = platform
}

function keyedCounter(text: string | undefined, key: string): number | undefined {
  const match = text?.match(new RegExp(`^${key} (\\d+)$`, 'm'))
  return match ? Number(match[1]) : undefined
}

/** cgroup v2 path from the unified `0::/path` line; v1-only hosts have none. */
function cgroupPathOf(procCgroupFile: string): string | undefined {
  const match = fileReader(procCgroupFile)?.match(/^0::(\/.*)$/m)
  return match?.[1]
}

function cgroupDir(cgroupPath: string): string {
  return `/sys/fs/cgroup${cgroupPath === '/' ? '' : cgroupPath}`
}

function cgroupLeafKind(cgroupPath: string): LinuxCgroupLeafKind {
  const leaf = cgroupPath.split('/').findLast(Boolean)
  if (!leaf) {
    return 'root'
  }
  if (/^session-[^/]+\.scope$/.test(leaf)) {
    return 'login-session'
  }
  return /orca/i.test(leaf) ? 'orca' : 'other'
}

function readDaemonScopeCounter(counters: LinuxOomKillCounters, daemonPath: string): void {
  counters.daemonSharesCgroup = false
  counters.daemonCgroupPath = daemonPath
  counters.daemonCgroupOomKill = keyedCounter(
    fileReader(`${cgroupDir(daemonPath)}/memory.events`),
    'oom_kill'
  )
}

function readDaemonCgroup(
  counters: LinuxOomKillCounters,
  ownPath: string,
  pinnedDaemonPath: string | undefined
): void {
  // Why pinned: an OOM-killed or respawned daemon no longer leads to the baseline's scope by pid.
  if (pinnedDaemonPath) {
    readDaemonScopeCounter(counters, pinnedDaemonPath)
    return
  }
  const daemonPath = resolveDaemonCgroupPath()
  if (!daemonPath) {
    return
  }
  if (daemonPath === ownPath) {
    counters.daemonSharesCgroup = true
    return
  }
  // Why: a stale pid record can point at a recycled pid in an unrelated cgroup.
  if (!isDaemonScopeUnit(daemonPath.split('/').at(-1) ?? '')) {
    return
  }
  readDaemonScopeCounter(counters, daemonPath)
}

// Why cached: the pid source reads the pid file off disk, which a paging-storm poll must not
// repeat each tick; procfs alone tells us when the cached daemon has gone.
function resolveDaemonCgroupPath(): string | undefined {
  if (cachedDaemon) {
    const path = cgroupPathOf(`/proc/${cachedDaemon.pid}/cgroup`)
    if (path === cachedDaemon.cgroupPath) {
      return path
    }
    cachedDaemon = null
  }
  const pid = daemonPidSource?.()
  if (!pid || pid <= 0) {
    return undefined
  }
  const path = cgroupPathOf(`/proc/${pid}/cgroup`)
  if (path) {
    cachedDaemon = { pid, cgroupPath: path }
  }
  return path
}

function ancestorMemoryLimits(cgroupPath: string): LinuxCgroupMemoryLimit[] {
  // Why every ancestor: the tightest limit, and the one that fired, may sit on any slice above.
  const segments = cgroupPath.split('/').filter(Boolean)
  const limits: LinuxCgroupMemoryLimit[] = []
  for (let depth = segments.length; depth >= 0; depth--) {
    const dir = `/sys/fs/cgroup/${segments.slice(0, depth).join('/')}`.replace(/\/$/, '')
    const raw = fileReader(`${dir}/memory.max`)?.trim()
    if (raw && /^\d+$/.test(raw)) {
      limits.push({
        dir,
        maxMB: Math.round(Number(raw) / (1024 * 1024)),
        // Why local: hierarchical `oom` also moves when a sibling hits its own smaller limit.
        localOomEvents: keyedCounter(fileReader(`${dir}/memory.events.local`), 'oom')
      })
    }
  }
  return limits
}

/** `pinnedDaemonCgroupPath`: the baseline's daemon scope, read by path at process-gone time. */
export function readLinuxOomKillCounters(
  pinnedDaemonCgroupPath?: string
): LinuxOomKillCounters | null {
  if (counterPlatform !== 'linux') {
    return null
  }
  const counters: LinuxOomKillCounters = {
    vmstatOomKill: keyedCounter(fileReader('/proc/vmstat'), 'oom_kill')
  }
  const cgroupPath = cgroupPathOf('/proc/self/cgroup')
  if (cgroupPath) {
    counters.cgroupOomKill = keyedCounter(
      fileReader(`${cgroupDir(cgroupPath)}/memory.events`),
      'oom_kill'
    )
    counters.cgroupLeafKind = cgroupLeafKind(cgroupPath)
    try {
      readDaemonCgroup(counters, cgroupPath, pinnedDaemonCgroupPath)
    } catch {
      // Why: the daemon split is optional; Orca's own counters still stand.
    }
    const limits = ancestorMemoryLimits(cgroupPath)
    if (limits.length > 0) {
      counters.memoryLimits = limits
      counters.cgroupMemoryMaxMB = Math.min(...limits.map((limit) => limit.maxMB))
    }
  }
  const avg10 = fileReader('/proc/pressure/memory')?.match(/^some avg10=([\d.]+)/m)?.[1]
  if (avg10 !== undefined) {
    counters.memoryPressureSomeAvg10 = Number(avg10)
  }
  return counters
}

// Why "cgroup" in the names: on systemd hosts the terminal daemon and its agents sit in a
// sibling `orca-daemon-*.scope`, and a shell-launched Orca shares its terminal's scope.
export type LinuxOomKillVerdict =
  | 'orca-cgroup-oom-kill'
  // Orca's cgroup also holds the login session, launching terminal, or daemon, so the victim may be theirs.
  | 'shared-cgroup-oom-kill'
  | 'daemon-cgroup-oom-kill'
  | 'oom-kill-outside-orca-cgroups'
  | 'host-oom-kill-unattributed'
  | 'no-kernel-oom-kill'

/** Which OOM killed the Orca process: a memory.max above Orca, or the global (system-wide) one. */
export type LinuxOomKillScope = 'memcg-limit' | 'global'

function counterDelta(before: number | undefined, after: number | undefined): number | undefined {
  return before === undefined || after === undefined ? undefined : Math.max(0, after - before)
}

function oomKillVerdict(
  vmstatDelta: number | undefined,
  cgroupDelta: number | undefined,
  daemonCgroupDelta: number | undefined,
  daemonCovered: boolean,
  cgroupExclusive: boolean
): LinuxOomKillVerdict {
  // Why Orca's cgroup first: renderers live there, while a host kill may be anyone's.
  if ((cgroupDelta ?? 0) > 0) {
    return cgroupExclusive ? 'orca-cgroup-oom-kill' : 'shared-cgroup-oom-kill'
  }
  if ((daemonCgroupDelta ?? 0) > 0) {
    return 'daemon-cgroup-oom-kill'
  }
  if ((vmstatDelta ?? 0) === 0) {
    return 'no-kernel-oom-kill'
  }
  // Why: the kernel bumps the victim's memcg on every OOM kill, so a still counter clears that cgroup.
  return cgroupDelta === 0 && daemonCovered
    ? 'oom-kill-outside-orca-cgroups'
    : 'host-oom-kill-unattributed'
}

function oomKillScope(
  baseline: LinuxOomKillCounters,
  current: LinuxOomKillCounters
): LinuxOomKillScope | undefined {
  const limits = current.memoryLimits ?? []
  if (limits.length === 0) {
    return 'global'
  }
  let unknown = false
  for (const limit of limits) {
    const before = baseline.memoryLimits?.find((b) => b.dir === limit.dir)?.localOomEvents
    const delta = counterDelta(before, limit.localOomEvents)
    if ((delta ?? 0) > 0) {
      return 'memcg-limit'
    }
    unknown ||= delta === undefined
  }
  return unknown ? undefined : 'global'
}

/**
 * Compares a reading taken before the death with one taken at process-gone.
 * The verdict is about kernel OOM activity in that window, not the exit cause:
 * read it beside `Reason: killed` / exit 9.
 */
export function linuxOomKillDetails(
  baseline: LinuxOomKillCounters,
  baselineAgeMs: number,
  current: LinuxOomKillCounters
): CrashReportDetails {
  const vmstatDelta = counterDelta(baseline.vmstatOomKill, current.vmstatOomKill)
  const cgroupDelta = counterDelta(baseline.cgroupOomKill, current.cgroupOomKill)
  // Why same path only: a daemon restart in the window moves it to a new scope with fresh counters.
  const daemonCgroupDelta =
    baseline.daemonCgroupPath !== undefined &&
    baseline.daemonCgroupPath === current.daemonCgroupPath
      ? counterDelta(baseline.daemonCgroupOomKill, current.daemonCgroupOomKill)
      : undefined
  if (vmstatDelta === undefined && cgroupDelta === undefined) {
    return {}
  }
  const details: CrashReportDetails = {
    linuxOomKillBaselineAgeMs: Math.max(0, baselineAgeMs)
  }
  if (vmstatDelta !== undefined) {
    details.linuxOomKillHostDelta = vmstatDelta
  }
  if (cgroupDelta !== undefined) {
    details.linuxOomKillCgroupDelta = cgroupDelta
  }
  if (current.cgroupLeafKind !== undefined) {
    details.linuxOomKillCgroupLeafKind = current.cgroupLeafKind
  }
  if (daemonCgroupDelta !== undefined) {
    details.linuxOomKillDaemonCgroupDelta = daemonCgroupDelta
  }
  if (current.daemonSharesCgroup !== undefined) {
    details.linuxOomKillDaemonSharesCgroup = current.daemonSharesCgroup
  }
  // Why: an unknown or uncompared daemon scope may hold the kill, so only a checked one is cleared.
  const daemonCovered =
    daemonCgroupDelta === 0 ||
    (baseline.daemonSharesCgroup === true && current.daemonCgroupPath === undefined)
  const cgroupExclusive =
    current.cgroupLeafKind === 'orca' &&
    baseline.daemonSharesCgroup !== true &&
    current.daemonSharesCgroup !== true
  const verdict = oomKillVerdict(
    vmstatDelta,
    cgroupDelta,
    daemonCgroupDelta,
    daemonCovered,
    cgroupExclusive
  )
  details.linuxOomKillVerdict = verdict
  const scope =
    verdict === 'orca-cgroup-oom-kill' || verdict === 'shared-cgroup-oom-kill'
      ? oomKillScope(baseline, current)
      : undefined
  if (scope) {
    details.linuxOomKillScope = scope
  }
  if (current.cgroupMemoryMaxMB !== undefined) {
    details.linuxCgroupMemoryMaxMB = current.cgroupMemoryMaxMB
  }
  // Why the baseline's PSI: the gone-time reading follows the kill that relieved the pressure.
  if (baseline.memoryPressureSomeAvg10 !== undefined) {
    details.linuxMemoryPressurePreGoneSomeAvg10 = baseline.memoryPressureSomeAvg10
  }
  return details
}
