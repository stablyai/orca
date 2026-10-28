// WSL-host orcad must ignore Windows CLI shims; identify mounts by type because the automount root is configurable.
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { resolveCliCommand } from '../../shared/node-cli-command-resolution'

const WINDOWS_DRIVE_MOUNT_TYPES = new Set(['drvfs', '9p', 'virtiofs'])

/** WSL-host launch marker; SSH guests and WSLg retain their original PATH. */
export const ORCAD_WSL_HOST_ENV = 'ORCA_WSL_ORCAD_HOST'

let cachedGuestMounts: readonly string[] | null = null

export function isWslGuestProcess(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  interopRegistered: () => boolean = () => existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')
): boolean {
  if (platform !== 'linux') {
    return false
  }
  return Boolean(env.WSL_DISTRO_NAME?.trim() || env.WSL_INTEROP?.trim()) || interopRegistered()
}

export function isWslHostOrcadProcess(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  interopRegistered?: () => boolean
): boolean {
  return env[ORCAD_WSL_HOST_ENV] === '1' && isWslGuestProcess(env, platform, interopRegistered)
}

/** Decode /proc/mounts octal escapes, including whitespace and backslashes. */
function decodeMountField(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8))
  )
}

export function parseWindowsDriveMountPoints(procMounts: string): string[] {
  const mounts: string[] = []
  for (const line of procMounts.split('\n')) {
    const [, mountPoint, type] = line.trim().split(/\s+/)
    const decoded = mountPoint ? decodeMountField(mountPoint).replace(/\/+$/, '') : ''
    // Root would match every PATH entry and cannot be a Windows drive mount.
    if (decoded && type && WINDOWS_DRIVE_MOUNT_TYPES.has(type)) {
      mounts.push(decoded)
    }
  }
  return mounts
}

export function isUnderWindowsDriveMount(dir: string, mounts: readonly string[]): boolean {
  return mounts.some((mount) => dir === mount || dir.startsWith(`${mount}/`))
}

export function withoutWindowsDriveMountDirs(pathValue: string, mounts: readonly string[]): string {
  if (mounts.length === 0) {
    return pathValue
  }
  return pathValue
    .split(':')
    .filter((dir) => !isUnderWindowsDriveMount(dir.replace(/\/+$/, ''), mounts))
    .join(':')
}

export function readGuestWindowsDriveMounts(): readonly string[] {
  if (cachedGuestMounts) {
    return cachedGuestMounts
  }
  let mounts: string[] = []
  if (isWslHostOrcadProcess()) {
    try {
      mounts = parseWindowsDriveMountPoints(readFileSync('/proc/mounts', 'utf8'))
    } catch {
      // Unreadable: keep PATH as is rather than guess which entries are Windows drives.
    }
  }
  cachedGuestMounts = mounts
  return mounts
}

/** Keep CLI launches consistent with detection by removing Windows drive PATH entries only in WSL-host orcad. */
export function guestNativePathEnv(
  pathEnv: string | null | undefined,
  mounts: readonly string[] = readGuestWindowsDriveMounts()
): string | null | undefined {
  if (mounts.length === 0) {
    return pathEnv
  }
  const value = pathEnv ?? process.env.PATH ?? null
  return value === null ? null : withoutWindowsDriveMountDirs(value, mounts)
}

/** A one-shot agent child's env on a WSL-host orcad: its PATH lookup can't reach a Windows shim. */
export function guestNativeSpawnEnv(
  env: NodeJS.ProcessEnv,
  mounts: readonly string[] = readGuestWindowsDriveMounts()
): NodeJS.ProcessEnv {
  if (mounts.length === 0) {
    return env
  }
  const pathEnv = guestNativePathEnv(env.PATH ?? null, mounts)
  return pathEnv === null || pathEnv === undefined ? env : { ...env, PATH: pathEnv }
}

/**
 * Resolve an agent program as a WSL-host orcad must: never a Windows-drive copy. `null` means only a
 * Windows copy exists; a bare name would reach it through the spawn's own PATH lookup.
 */
export function resolveGuestNativeProgram(
  command: string,
  options: NonNullable<Parameters<typeof resolveCliCommand>[1]>,
  resolve: typeof resolveCliCommand = resolveCliCommand,
  mounts: readonly string[] = readGuestWindowsDriveMounts()
): string | null {
  if (mounts.length === 0) {
    return resolve(command, options)
  }
  const native = resolve(command, {
    ...options,
    pathEnv: guestNativePathEnv(options.pathEnv, mounts)
  })
  if (isAbsolute(native)) {
    return native
  }
  return isAbsolute(resolve(command, options)) ? null : native
}
