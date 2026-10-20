import { posix } from 'node:path'
import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'
import type { RepositoryAddScriptTarget } from '../../shared/repository-add-script-types'
import { parseWslUncPath, toLinuxPath } from '../../shared/wsl-paths'
import { getHookRuntimeTarget } from '../hook-runtime-target'

const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/

function isUsableText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0')
}

function wslTarget(distro: string, cwd: string): RepositoryAddScriptTarget | null {
  // Guest cleanup targets this distro by name, so the default distro is never enough.
  return isUsableText(distro) &&
    distro.trim() === distro &&
    isUsableText(cwd) &&
    posix.isAbsolute(cwd)
    ? { kind: 'wsl', distro, cwd }
    : null
}

/** Validated copy that never shares the caller's object or carries extra fields. */
export function copyRepositoryAddScriptTarget(
  value: RepositoryAddScriptTarget | null | undefined
): RepositoryAddScriptTarget | null {
  if (value?.kind === 'native') {
    return isUsableText(value.cwd) ? { kind: 'native', cwd: value.cwd } : null
  }
  return value?.kind === 'wsl' ? wslTarget(value.distro, value.cwd) : null
}

export function isSameRepositoryAddScriptTarget(
  left: RepositoryAddScriptTarget | null | undefined,
  right: RepositoryAddScriptTarget | null | undefined
): boolean {
  if (!left || !right || left.kind !== right.kind || left.cwd !== right.cwd) {
    return false
  }
  return left.kind === 'native' || (right.kind === 'wsl' && left.distro === right.distro)
}

/**
 * The one placement rule shared by approval and execution, following hook placement: a WSL UNC
 * path runs in its own distro, a WSL runtime routes a drive path through its distro, and anything
 * unresolved, needing repair, or contradictory is refused rather than defaulted to native.
 */
export function resolveRepositoryAddScriptTarget(
  path: string,
  runtime: ProjectExecutionRuntimeResolution | undefined,
  platform: NodeJS.Platform
): RepositoryAddScriptTarget | null {
  if (!isUsableText(path) || (runtime && runtime.status !== 'resolved')) {
    return null
  }
  if (platform !== 'win32') {
    // Off Windows no runtime still means this host, as before project runtimes existed.
    if (runtime && runtime.runtime.kind !== 'local-host') {
      return null
    }
    return posix.isAbsolute(path) ? { kind: 'native', cwd: path } : null
  }
  if (!runtime || runtime.runtime.kind === 'local-host') {
    return null
  }
  const requested =
    runtime.runtime.kind === 'wsl' ? (getHookRuntimeTarget(runtime)?.wslDistro?.trim() ?? '') : null
  // getHookWslContext lets a UNC distro override the requested one; a mismatch is refused here.
  const unc = parseWslUncPath(path)
  if (unc) {
    return requested === null || requested === unc.distro
      ? wslTarget(unc.distro, unc.linuxPath)
      : null
  }
  if (requested !== null) {
    return requested && WINDOWS_DRIVE_PATH.test(path)
      ? wslTarget(requested, toLinuxPath(path))
      : null
  }
  // cmd.exe cannot use a UNC or device cwd and silently falls back to the Windows directory.
  return WINDOWS_DRIVE_PATH.test(path) ? { kind: 'native', cwd: path } : null
}
