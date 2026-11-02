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
export function getSystem32ExePath(exe: string, env: NodeJS.ProcessEnv = process.env): string {
  const systemRoot = env.SystemRoot?.trim()
  const root = systemRoot && /^[a-z]:[\\/]/i.test(systemRoot) ? systemRoot : 'C:\\Windows'
  return win32.join(root, 'System32', exe)
}

export function getRegExePath(env: NodeJS.ProcessEnv = process.env): string {
  return getSystem32ExePath('reg.exe', env)
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

export function isPermissionError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    ((error as NodeJS.ErrnoException).code === 'EACCES' ||
      (error as NodeJS.ErrnoException).code === 'EPERM')
  )
}

const USER_DIRECTORY_GRANT = { inheritable: true, replace: true } as const

/** An explicit user grant makes the directory writable when Chromium's inherited ACEs do not. */
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

/** Run the subtree grant on the thread pool. */
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
