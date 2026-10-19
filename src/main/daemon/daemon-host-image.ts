/**
 * Whether a Linux daemon's program files still exist (#18200). An AppImage daemon runs from a FUSE
 * mount (`.mount_*`) or a runtime extract dir (`appimage_extracted_*`); once that goes, the next
 * cold page faults with SIGBUS. The probe reads only `/proc` paths and the daemon's mount table, so
 * a dead or wedged FUSE server cannot block it.
 *
 * `severed` is a health verdict, never liveness: the daemon may keep serving for hours.
 */
import { lstatSync, readFileSync, readlinkSync } from 'node:fs'
import type { ParsedDaemonPid } from './daemon-pid-file-parse'
import { parseLinuxStartTicks } from '../agent-hooks/managed-hook-owner-identity'
import { isFuseMountPoint } from './daemon-appimage-launch'

export type DaemonHostImageVerdict = 'intact' | 'severed' | 'unknown' | 'not-ephemeral'

export type DaemonHostImageInspection = {
  verdict: DaemonHostImageVerdict
  pid: number | null
  linuxStartTicks: string | null
  bootId: string | null
}

export type DaemonHostImageProc = {
  readlink(path: string): string
  readFile(path: string): string
  /** True when the path names an entry; throws on anything but ENOENT. */
  exists(path: string): boolean
}

const linuxProc: DaemonHostImageProc = {
  readlink: (path) => readlinkSync(path),
  readFile: (path) => readFileSync(path, 'utf8'),
  exists: (path) => {
    try {
      lstatSync(path)
      return true
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTDIR')) {
        return false
      }
      throw error
    }
  }
}

const DELETED_SUFFIX = ' (deleted)'

export function inspectDaemonHostImage(
  record: ParsedDaemonPid | null,
  options: { proc?: DaemonHostImageProc; platform?: NodeJS.Platform } = {}
): DaemonHostImageInspection {
  const unknown = (): DaemonHostImageInspection => ({
    verdict: 'unknown',
    pid: record?.pid ?? null,
    linuxStartTicks: record?.linuxStartTicks ?? null,
    bootId: record?.bootId ?? null
  })
  if ((options.platform ?? process.platform) !== 'linux') {
    return { ...unknown(), verdict: 'not-ephemeral' }
  }
  if (!record || !record.linuxStartTicks || !record.bootId) {
    return unknown()
  }
  const proc = options.proc ?? linuxProc
  const result = (verdict: DaemonHostImageVerdict): DaemonHostImageInspection => ({
    ...unknown(),
    verdict
  })
  try {
    // Verify the pid is still the recorded incarnation before reading anything else about it.
    const startTicks = parseLinuxStartTicks(proc.readFile(`/proc/${record.pid}/stat`))
    const bootId = proc.readFile('/proc/sys/kernel/random/boot_id').trim()
    if (startTicks !== record.linuxStartTicks || bootId !== record.bootId) {
      return unknown()
    }
    const executable = proc.readlink(`/proc/${record.pid}/exe`)
    const deleted = executable.endsWith(DELETED_SUFFIX)
    const path = deleted ? executable.slice(0, -DELETED_SUFFIX.length) : executable
    const ephemeralOrigin = [record.spawnerExecPath, record.entryPath, path].some(
      (candidate) => candidate !== null && ephemeralRootOf(candidate) !== null
    )
    if (!ephemeralOrigin) {
      return result('not-ephemeral')
    }
    const root = ephemeralRootOf(path)
    if (root?.kind === 'mount') {
      const mounted = isFuseMountPoint(proc.readFile(`/proc/${record.pid}/mountinfo`), root.path)
      return result(mounted && !deleted ? 'intact' : 'severed')
    }
    if (deleted) {
      return result(root ? 'severed' : 'not-ephemeral')
    }
    // After a lazy unmount the kernel renders the path relative to the detached mount
    // ("/orca-ide"), which resolves to nothing in the daemon's own root.
    const resolves = proc.exists(`/proc/${record.pid}/root${path}`)
    if (root) {
      return result(resolves ? 'intact' : 'severed')
    }
    return result(resolves ? 'not-ephemeral' : 'severed')
  } catch {
    // EACCES (hidepid), an exited pid, or an unreadable mount table: say nothing.
    return unknown()
  }
}

type EphemeralRoot = { kind: 'mount' | 'extract'; path: string }

/** The AppImage mount point or runtime extract dir a path lives under, if any. */
export function ephemeralRootOf(path: string): EphemeralRoot | null {
  const segments = path.split('/')
  for (let index = 1; index < segments.length - 1; index += 1) {
    const segment = segments[index]!
    if (segment.startsWith('.mount_')) {
      return { kind: 'mount', path: segments.slice(0, index + 1).join('/') }
    }
    if (segment.startsWith('appimage_extracted_')) {
      return { kind: 'extract', path: segments.slice(0, index + 1).join('/') }
    }
  }
  return null
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}
