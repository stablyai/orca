import { posix } from 'node:path'
import type { HostPressureLevel } from '../../../shared/terminal/pty/admission/spawn-admission-contract'
import {
  NodeFileReadTooLargeError,
  readNodeFileWithinLimit
} from '../../../shared/file-content/node-bounded-file-reader'
import { cgroupPathFromProcLine } from '../process-scopes/daemon-user-manager-lifetime'

/** The fullest cgroup task limit over this process: tasks in use and the cap they count against. */
export type CgroupPidsUsage = { current: number; max: number; cgroup: string }

/** A cgroup's pids.max counts threads too, so refuse new automatic spawns before it is full (#40327). */
export const CGROUP_PIDS_CRITICAL_RATIO = 0.9
const CGROUP_PIDS_CLEAR_RATIO = 0.85

type CgroupMount = { root: string; mountPoint: string; fsType: string; superOptions: string[] }

/** cgroup mounts from /proc/self/mountinfo: `id parent dev root mountpoint opts [tags] - fstype src superopts`. */
function cgroupMounts(mountinfo: string): CgroupMount[] {
  const mounts: CgroupMount[] = []
  for (const line of mountinfo.split('\n')) {
    const fields = line.split(' ')
    const separator = fields.indexOf('-')
    const fsType = fields[separator + 1]
    if (separator < 6 || (fsType !== 'cgroup' && fsType !== 'cgroup2')) {
      continue
    }
    mounts.push({
      root: unescapeMountField(fields[3]),
      mountPoint: unescapeMountField(fields[4]),
      fsType,
      superOptions: (fields[separator + 3] ?? '').split(',')
    })
  }
  return mounts
}

function isWithin(root: string, path: string): boolean {
  const relative = posix.relative(root, path)
  return !relative.startsWith('..') && !posix.isAbsolute(relative)
}

function unescapeMountField(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8))
  )
}

/** Directories whose pids.max can cap this process: its own cgroup and every ancestor within the
 *  mount that holds the pids controller, found in mountinfo (v1 may co-mount it, e.g. `cpu,pids`).
 *  A v1 pids line wins over the v2 `0::` line, since on a hybrid host pids is a v1 controller. A
 *  path outside the mount's root (or this namespace's root) names nothing we can read. */
export function cgroupPidsDirectories(procSelfCgroup: string, mountinfo: string): string[] {
  const lines = procSelfCgroup.split('\n').filter((line) => line.includes(':'))
  const v1 = lines.find((line) => line.split(':')[1]?.split(',').includes('pids'))
  const line = v1 ?? lines.find((line) => line.split(':')[1] === '')
  if (!line) {
    return []
  }
  // A cgroup removed while this process is still in it reads as `<path> (deleted)`.
  const raw = cgroupPathFromProcLine(line).replace(/ \(deleted\)$/, '')
  if (!raw.startsWith('/') || raw === '/..' || raw.startsWith('/../')) {
    return []
  }
  const path = posix.normalize(raw)
  // Of the mounts of this hierarchy (bind mounts can expose several), use the one whose root holds
  // the path with the most ancestors visible: every ancestor's pids.max can cap this process.
  const mount = cgroupMounts(mountinfo)
    .filter((candidate) =>
      line === v1
        ? candidate.fsType === 'cgroup' && candidate.superOptions.includes('pids')
        : candidate.fsType === 'cgroup2'
    )
    .filter((candidate) => isWithin(candidate.root, path))
    .sort((a, b) => a.root.length - b.root.length)[0]
  if (!mount) {
    return []
  }
  const relative = posix.relative(mount.root, path)
  const directories: string[] = []
  for (let dir = relative; ; dir = posix.dirname(dir)) {
    directories.push(
      dir === '' || dir === '.' ? mount.mountPoint : posix.join(mount.mountPoint, dir)
    )
    if (dir === '' || dir === '.') {
      return directories
    }
  }
}

function parseCount(raw: string): number | null {
  const text = raw.trim()
  return /^\d+$/.test(text) ? Number(text) : null
}

function fullness(current: number, max: number): number {
  return max === 0 ? Number.POSITIVE_INFINITY : current / max
}

/** The fullest capped cgroup; null when none caps tasks (or this is not Linux). */
export function fullestPidsUsage(
  readings: readonly { cgroup: string; current: string; max: string }[]
): CgroupPidsUsage | null {
  let fullest: CgroupPidsUsage | null = null
  for (const reading of readings) {
    const max = parseCount(reading.max)
    const current = parseCount(reading.current)
    if (max === null || current === null) {
      continue // `max` means unlimited; an unreadable file proves nothing
    }
    // A cap of 0 admits nothing, so it is the fullest of all.
    if (!fullest || fullness(current, max) > fullness(fullest.current, fullest.max)) {
      fullest = { current, max, cgroup: reading.cgroup }
    }
  }
  return fullest
}

/** Critical from 90% of the cap; once critical, it stays so until usage falls below 85%. */
export function cgroupPidsPressure(
  usage: CgroupPidsUsage | null,
  previous: HostPressureLevel = 'ok'
): HostPressureLevel {
  if (!usage) {
    return 'ok'
  }
  const ratio = previous === 'critical' ? CGROUP_PIDS_CLEAR_RATIO : CGROUP_PIDS_CRITICAL_RATIO
  return usage.current >= usage.max * ratio ? 'critical' : 'ok'
}

async function readSmallFile(path: string): Promise<string | null> {
  try {
    return (await readNodeFileWithinLimit(path, 4096)).buffer.toString('utf8')
  } catch {
    return null
  }
}

/** Where the task caps live, resolved once; `problem` says why none could be found. */
export type CgroupPidsDirectories = {
  directories: string[]
  problem?: 'cgroup-unreadable' | 'mountinfo-unreadable' | 'mountinfo-too-large' | 'no-pids-mount'
}

const MAX_MOUNTINFO_BYTES = 4 * 1024 * 1024

async function readCgroupMembership(): Promise<string | null> {
  return process.platform === 'linux' ? readSmallFile('/proc/self/cgroup') : null
}

async function resolveCgroupPidsDirectories(self: string | null): Promise<CgroupPidsDirectories> {
  if (process.platform !== 'linux') {
    return { directories: [] }
  }
  if (!self) {
    return { directories: [], problem: 'cgroup-unreadable' }
  }
  let mountinfo: string
  try {
    const read = await readNodeFileWithinLimit('/proc/self/mountinfo', MAX_MOUNTINFO_BYTES)
    mountinfo = read.buffer.toString('utf8')
  } catch (error) {
    return {
      directories: [],
      problem:
        error instanceof NodeFileReadTooLargeError ? 'mountinfo-too-large' : 'mountinfo-unreadable'
    }
  }
  const directories = cgroupPidsDirectories(self, mountinfo)
  return directories.length > 0 ? { directories } : { directories, problem: 'no-pids-mount' }
}

/** A task-limit reader that finds the cgroup directories once (they don't move while this
 *  process runs) and reports how that went, so a host where protection is off says why. */
export function createCgroupPidsReader(
  onResolved: (resolution: CgroupPidsDirectories) => void = () => {},
  resolve: (
    membership: string | null
  ) => Promise<CgroupPidsDirectories> = resolveCgroupPidsDirectories,
  readMembership: () => Promise<string | null> = readCgroupMembership
): () => Promise<CgroupPidsUsage | null> {
  let resolution: {
    membership: string | null
    directories: Promise<CgroupPidsDirectories>
  } | null = null
  return async () => {
    // A daemon can be moved into a new scope while it runs; re-resolve when its cgroup changes.
    const membership = await readMembership()
    if (!resolution || resolution.membership !== membership) {
      const directories = resolve(membership).then((resolved) => {
        onResolved(resolved)
        return resolved
      })
      resolution = { membership, directories }
    }
    const { directories } = await resolution.directories
    if (directories.length === 0) {
      return null
    }
    const readings = await Promise.all(
      directories.map(async (cgroup) => ({
        cgroup,
        current: (await readSmallFile(posix.join(cgroup, 'pids.current'))) ?? '',
        max: (await readSmallFile(posix.join(cgroup, 'pids.max'))) ?? ''
      }))
    )
    return fullestPidsUsage(readings)
  }
}
