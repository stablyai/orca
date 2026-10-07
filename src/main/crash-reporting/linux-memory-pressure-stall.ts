import { readLinuxPseudoFile, resolveCgroupV2MemoryDir } from './linux-cgroup-memory-limit'

// ─── Linux PSI memory stall for crash reports ───────────────────────
// Why: neither MemAvailable nor a cgroup ceiling can name systemd-oomd, which is
// default-enabled on Arch and Fedora and kills an entire cgroup on PSI memory
// STALL, never on free memory. Three v1.4.200 field SIGKILLs (2ea53f9c,
// ad185d76, 181e8e36) all showed ~100% free swap and gigabytes of MemAvailable,
// so nothing in the report separated oomd from a kernel OOM or an outside kill.
// oomd stays a CANDIDATE for those three, not the finding: its whole-cgroup
// scope sits badly with a main process that survived all three, and this reading
// exists to settle that either way (docs/reference/linux-memory-kill-attribution.md).
//
// avgN is the percentage of the last N seconds tasks spent stalled on memory:
// `some` = at least one task, `full` = every task, which is the one oomd watches
// (its default trip is 50-60% `full` avg10 sustained for 30 s). High stall beside
// a healthy MemAvailable is the oomd signature.
//
// PSI is absent on kernels built without CONFIG_PSI and on most WSL2 kernels;
// that is a normal answer, not an error.

/** Percentages of a window spent stalled; a field is absent when the kernel omits its line. */
export type MemoryStallAverages = {
  someAvg10?: number
  someAvg60?: number
  fullAvg10?: number
  fullAvg60?: number
}

export type LinuxMemoryPressureStall = {
  /** `/proc/pressure/memory` — the whole host. */
  host?: MemoryStallAverages
  /** The cgroup's own `memory.pressure`, which is what systemd-oomd actually reads. */
  cgroup?: MemoryStallAverages
}

/**
 * Deliberately below systemd-oomd's 50-60% default trip: a crash report reads
 * PSI after the kill, by which point the decaying average understates the stall
 * that caused it.
 */
export const MEMORY_STALL_HIGH_AVG10_PERCENT = 30

type LinuxMemoryPressureStallReader = () => LinuxMemoryPressureStall | undefined

/** Lines are `some avg10=1.23 avg60=4.56 avg300=0.00 total=123456`. */
export function parseMemoryPressureStall(raw: string | undefined): MemoryStallAverages | undefined {
  if (raw === undefined) {
    return undefined
  }
  const stall: MemoryStallAverages = {}
  for (const line of raw.split('\n')) {
    const [kind, ...fields] = line.trim().split(/\s+/)
    if (kind !== 'some' && kind !== 'full') {
      continue
    }
    for (const field of fields) {
      const [name, rawPercent] = field.split('=')
      if (name !== 'avg10' && name !== 'avg60') {
        continue
      }
      const percent = Number(rawPercent)
      if (Number.isFinite(percent)) {
        stall[`${kind}${name === 'avg10' ? 'Avg10' : 'Avg60'}`] = percent
      }
    }
  }
  return Object.keys(stall).length > 0 ? stall : undefined
}

function readLinuxMemoryPressureStallFromProcfs(): LinuxMemoryPressureStall | undefined {
  const host = parseMemoryPressureStall(readLinuxPseudoFile('/proc/pressure/memory'))
  const dir = resolveCgroupV2MemoryDir()
  const cgroup =
    dir === undefined
      ? undefined
      : parseMemoryPressureStall(readLinuxPseudoFile(`${dir}/memory.pressure`))
  // No PSI at all must stay silent: a row of zeroes would read as "measured, and calm".
  return host === undefined && cgroup === undefined ? undefined : { host, cgroup }
}

let reader: LinuxMemoryPressureStallReader = readLinuxMemoryPressureStallFromProcfs

export function setLinuxMemoryPressureStallReaderForTest(
  next: LinuxMemoryPressureStallReader | null
): void {
  reader = next ?? readLinuxMemoryPressureStallFromProcfs
}

export function readLinuxMemoryPressureStall(
  platform: NodeJS.Platform = process.platform
): LinuxMemoryPressureStall | undefined {
  if (platform !== 'linux') {
    return undefined
  }
  try {
    return reader()
  } catch {
    return undefined
  }
}
