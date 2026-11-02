import { delimiter, join, win32 } from 'node:path'
import { existsSync } from 'node:fs'
import { loadWindowsSecurity, WINDOWS_FILE_ALL_ACCESS } from '../shared/windows-security-addon'

export {
  getCmdExePath,
  getSpawnArgsForWindows,
  wrapWindowsStartWait,
  isWindowsBatchScript,
  WINDOWS_BATCH_UNSAFE_ARGUMENTS_ERROR,
  WINDOWS_BATCH_UNSAFE_CHARACTERS_LABEL,
  UnsafeWindowsBatchArgumentsError,
  type GetSpawnArgsForWindowsOptions
} from '../shared/windows-batch-spawn'

/** Absolute path because service-launched Electron can omit System32 from PATH. */
export function getRegExePath(env: NodeJS.ProcessEnv = process.env): string {
  const systemRoot = env.SystemRoot?.trim()
  const root = systemRoot && /^[a-z]:[\\/]/i.test(systemRoot) ? systemRoot : 'C:\\Windows'
  return win32.join(root, 'System32', 'reg.exe')
}

export function resolveWindowsCommand(
  command: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (process.platform !== 'win32') {
    return command
  }
  if (/[\\/]/.test(command) || /\.[a-z0-9]+$/i.test(command)) {
    return command
  }

  const pathEnv = env.PATH ?? env.Path
  if (!pathEnv) {
    return command
  }

  for (const directory of pathEnv.split(delimiter).filter(Boolean)) {
    for (const name of [`${command}.cmd`, `${command}.exe`, `${command}.bat`, command]) {
      const candidate = join(directory, name)
      if (existsSync(candidate)) {
        return candidate
      }
    }
  }
  return command
}

/** EACCES or EPERM. */
export function isPermissionError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    ((error as NodeJS.ErrnoException).code === 'EACCES' ||
      (error as NodeJS.ErrnoException).code === 'EPERM')
  )
}

const USER_DIRECTORY_GRANT = { inheritable: true, replace: true } as const

/**
 * Grant Full Control (OI)(CI)(F) on a directory for the current user.
 * Used to fix Chromium's Protected DACL propagation which leaves child
 * directories with Inherit-Only ACEs that deny direct file creation.
 *
 * Why replace the user's rule rather than restore inheritance: Chromium's ACEs carry the
 * Inherit-Only flag when propagated to children, so restoring inheritance does not grant the
 * directory itself any effective permissions. An explicit ACE survives future DACL propagation
 * and grants create-file rights.
 *
 * Throws when the grant fails; a host without the native addon is a silent no-op, which leaves
 * the caller's original EPERM to surface.
 */
export function grantDirAcl(dirPath: string): void {
  const security = loadWindowsSecurity()
  if (!('error' in security)) {
    security.addon.grantAccess(
      dirPath,
      security.userSid,
      WINDOWS_FILE_ALL_ACCESS,
      USER_DIRECTORY_GRANT
    )
  }
}

/** As grantDirAcl, on the thread pool: the grant propagates through the directory's subtree. */
export async function grantDirAclAsync(dirPath: string): Promise<void> {
  const security = loadWindowsSecurity()
  if (!('error' in security)) {
    await security.addon.grantAccessAsync(
      dirPath,
      security.userSid,
      WINDOWS_FILE_ALL_ACCESS,
      USER_DIRECTORY_GRANT
    )
  }
}
