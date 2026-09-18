import { readFileSync } from 'node:fs'

// ─── cgroup v2 memory accounting for Linux crash reports ────────────
// Why: /proc/meminfo — which `process.getSystemMemoryInfo()` reads, and which is
// the entire Linux memory story a crash report currently tells — is host-wide
// and knows nothing about the cgroup Orca actually runs in. A systemd user unit
// with MemoryMax, a Flatpak/snap sandbox or a container kills our renderer with
// SIGKILL while MemAvailable sits at 20 GB and swap is 100% free, so the report
// reads "plenty of memory" and the death is unexplainable (field report
// 2ea53f9c: lone renderer exit 9, no siblings, no pressure).
//
// `memory.events`' `oom_kill` is the decisive datum and the reason this exists:
// the kernel increments it exactly when it OOM-kills a task in our cgroup. The
// pre-gone sampler carries an earlier reading of the same counter, so a report
// that shows it stepping across the death says the kernel did it — and one that
// shows it unchanged rules the cgroup out, leaving systemd-oomd or an external
// kill (see docs/reference/linux-memory-kill-attribution.md).
//
// The ceilings are read over our cgroup AND its ancestors, because the kernel
// enforces the minimum of that chain: a snap quota slice or a `MemoryMax=` on
// `user.slice` sits above the unit we run in, and our own file still reads `max`.
//
// v1 is deliberately unsupported: its hierarchy is per-controller and its limit
// is unreadable from `/proc/self/cgroup` alone without mount parsing, and a
// half-right limit is worse than an absent one here.

const CGROUP_V2_MOUNT = '/sys/fs/cgroup'
const BYTES_PER_MB = 1024 * 1024

export type LinuxCgroupMemoryLimit = {
  /**
   * Lowest `memory.max` over this cgroup AND every visible ancestor, in bytes;
   * undefined when none of them sets one. The kernel enforces the minimum of the
   * chain, so our own file reading `max` does not mean we are uncapped.
   */
  maxBytes?: number
  /** Same, for `memory.high`: an ancestor over its high throttles us too. */
  highBytes?: number
  /** OUR cgroup's usage, which is only our share when the ceiling is an ancestor's. */
  currentBytes?: number
  /** Usage at the ancestor owning the binding ceiling; absent when that ceiling is our own. */
  ceilingCurrentBytes?: number
  /** Kernel OOM kills of a task in this cgroup or below it, since its creation. */
  oomKillCount?: number
  /** Times usage would have exceeded `memory.max` AT OUR LEVEL (see `ceilingCurrentBytes`). */
  maxEventCount?: number
  /** Times usage was throttled against `memory.high` at our level. */
  highEventCount?: number
  /**
   * Whether the walked chain ended at the machine's real root cgroup, so an
   * absent ceiling means uncapped over every ancestor and not merely over the
   * ones we could see. False inside a cgroup namespace, where the mount root is
   * our own cgroup and a pod or slice ceiling above it is unreadable from here.
   */
  chainReachesRoot?: boolean
}

/** One cgroup's ceiling, kept with its directory so the binding level can be read back. */
type CgroupCeiling = { bytes: number; dir: string }

type LinuxCgroupMemoryLimitReader = () => LinuxCgroupMemoryLimit | undefined

type LinuxPseudoFileReader = (filePath: string) => string | undefined

/** Absent is a normal answer here: hardened hosts, WSL and containers hide these. */
function readLinuxPseudoFileFromDisk(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, 'utf8')
  } catch {
    return undefined
  }
}

let pseudoFileReader: LinuxPseudoFileReader = readLinuxPseudoFileFromDisk

/** The seam the sysfs resolution itself is tested through; PSI reads through it too. */
export function setLinuxPseudoFileReaderForTest(next: LinuxPseudoFileReader | null): void {
  pseudoFileReader = next ?? readLinuxPseudoFileFromDisk
}

export function readLinuxPseudoFile(filePath: string): string | undefined {
  return pseudoFileReader(filePath)
}

/** The unified-hierarchy line is the one with an empty controller list. */
export function parseCgroupV2Path(procSelfCgroup: string): string | undefined {
  for (const line of procSelfCgroup.split('\n')) {
    if (line.startsWith('0::')) {
      const relative = line.slice('0::'.length).trim()
      return relative.startsWith('/') ? relative : undefined
    }
  }
  return undefined
}

/**
 * Where this process's cgroup memory files could be, best candidate first.
 *
 * Under a cgroup namespace (containers, some Flatpak runtimes) the mount root IS
 * our cgroup and the path `/proc/self/cgroup` reports names a directory that does
 * not exist inside; with a host cgroupns it is the other way round. Probing both
 * is the difference between a readable limit and nothing at all in a sandbox.
 */
export function cgroupV2MemoryDirCandidates(relative: string | undefined): string[] {
  return relative === undefined || relative === '/'
    ? [CGROUP_V2_MOUNT]
    : [`${CGROUP_V2_MOUNT}${relative}`, CGROUP_V2_MOUNT]
}

export function resolveCgroupV2MemoryDir(): string | undefined {
  const relative = parseCgroupV2Path(readLinuxPseudoFile('/proc/self/cgroup') ?? '')
  return cgroupV2MemoryDirCandidates(relative).find(
    // The root cgroup has no memory.current, so this also rejects the host root.
    (dir) => readLinuxPseudoFile(`${dir}/memory.current`) !== undefined
  )
}

/** `max` means unlimited, and must not be reported as a numeric ceiling. */
export function parseCgroupMemoryBytes(raw: string | undefined): number | undefined {
  const value = raw?.trim()
  if (value === undefined || value === '' || value === 'max') {
    return undefined
  }
  const bytes = Number(value)
  return Number.isFinite(bytes) && bytes >= 0 ? bytes : undefined
}

export function parseCgroupMemoryEvent(raw: string | undefined, key: string): number | undefined {
  if (raw === undefined) {
    return undefined
  }
  for (const line of raw.split('\n')) {
    const [name, count] = line.trim().split(/\s+/)
    if (name === key) {
      const value = Number(count)
      return Number.isFinite(value) ? value : undefined
    }
  }
  return undefined
}

/**
 * Our cgroup and every ancestor up to the mount root, nearest first.
 *
 * Why the whole chain and not just ours: `memory.max` and `memory.high` are
 * enforced as the MINIMUM over it, so a snap quota slice, a `MemoryMax=` on
 * `user.slice`, or a Kubernetes pod cgroup caps us while our own file still
 * reads `max`. Reading only our level reports "no ceiling" on exactly the
 * sandboxes this module was written for.
 */
export function cgroupV2AncestorDirs(dir: string): string[] {
  if (dir !== CGROUP_V2_MOUNT && !dir.startsWith(`${CGROUP_V2_MOUNT}/`)) {
    return [dir]
  }
  const dirs = [dir]
  // Stops at the mount root: above it is the host's, or nothing inside a namespace.
  for (let current = dir; current !== CGROUP_V2_MOUNT;) {
    current = current.slice(0, current.lastIndexOf('/'))
    dirs.push(current)
  }
  return dirs
}

/** The lowest of a ceiling file over the chain — what the kernel actually enforces. */
function bindingCgroupCeiling(dirs: readonly string[], file: string): CgroupCeiling | undefined {
  let lowest: CgroupCeiling | undefined
  for (const dir of dirs) {
    const bytes = parseCgroupMemoryBytes(readLinuxPseudoFile(`${dir}/${file}`))
    if (bytes !== undefined && (lowest === undefined || bytes < lowest.bytes)) {
      lowest = { bytes, dir }
    }
  }
  return lowest
}

function lowerCeiling(
  a: CgroupCeiling | undefined,
  b: CgroupCeiling | undefined
): CgroupCeiling | undefined {
  if (a === undefined || b === undefined) {
    return a ?? b
  }
  return a.bytes <= b.bytes ? a : b
}

/**
 * Whether the walked chain really ends at the machine's root cgroup.
 *
 * Why it has to be reported: an absent `memory.max` means "no ceiling" only over
 * the levels we could see, and inside a cgroup namespace that is our own cgroup
 * and nothing above it — a Kubernetes pod cgroup or a `MemoryMax=` on the slice
 * hosting the container is enforced on us and unreadable from in here. Without
 * this flag an absent ceiling reads as "uncapped" on exactly the sandboxes the
 * ancestor walk exists for.
 *
 * `memory.current` exists on non-root cgroups only, so a readable one at the
 * mount root means the mount root is a cgroup — i.e. a namespace root, not the
 * machine's.
 */
function cgroupV2ChainReachesRoot(): boolean {
  return readLinuxPseudoFile(`${CGROUP_V2_MOUNT}/memory.current`) === undefined
}

function readLinuxCgroupMemoryLimitFromSysfs(): LinuxCgroupMemoryLimit | undefined {
  const dir = resolveCgroupV2MemoryDir()
  if (dir === undefined) {
    return undefined
  }
  // memory.events is hierarchical, so a renderer in a descendant cgroup still counts.
  const events = readLinuxPseudoFile(`${dir}/memory.events`)
  const chain = cgroupV2AncestorDirs(dir)
  const max = bindingCgroupCeiling(chain, 'memory.max')
  const high = bindingCgroupCeiling(chain, 'memory.high')
  const binding = lowerCeiling(max, high)
  const measured: LinuxCgroupMemoryLimit = {
    maxBytes: max?.bytes,
    highBytes: high?.bytes,
    currentBytes: parseCgroupMemoryBytes(readLinuxPseudoFile(`${dir}/memory.current`)),
    // Our own usage is not comparable to an ancestor's shared ceiling, so ship the
    // usage that ceiling actually counts against beside it.
    ceilingCurrentBytes:
      binding === undefined || binding.dir === dir
        ? undefined
        : parseCgroupMemoryBytes(readLinuxPseudoFile(`${binding.dir}/memory.current`)),
    oomKillCount: parseCgroupMemoryEvent(events, 'oom_kill'),
    maxEventCount: parseCgroupMemoryEvent(events, 'max'),
    highEventCount: parseCgroupMemoryEvent(events, 'high')
  }
  // Nothing readable means no v2 memory controller here; say nothing rather
  // than ship a row of undefineds that reads as "measured, and unlimited". The
  // chain flag is excluded because it always resolves, and on its own it
  // measures nothing about this host's memory.
  if (!Object.values(measured).some((value) => value !== undefined)) {
    return undefined
  }
  return { ...measured, chainReachesRoot: cgroupV2ChainReachesRoot() }
}

let reader: LinuxCgroupMemoryLimitReader = readLinuxCgroupMemoryLimitFromSysfs

export function setLinuxCgroupMemoryLimitReaderForTest(
  next: LinuxCgroupMemoryLimitReader | null
): void {
  reader = next ?? readLinuxCgroupMemoryLimitFromSysfs
}

export function readLinuxCgroupMemoryLimit(
  platform: NodeJS.Platform = process.platform
): LinuxCgroupMemoryLimit | undefined {
  if (platform !== 'linux') {
    return undefined
  }
  try {
    return reader()
  } catch {
    return undefined
  }
}

export function cgroupMemoryBytesToMB(bytes: number | undefined): number | undefined {
  return bytes === undefined ? undefined : Math.round(Math.max(0, bytes) / BYTES_PER_MB)
}
