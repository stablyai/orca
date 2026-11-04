import { loadWindowsSecurity, WINDOWS_FILE_ALL_ACCESS } from '../../shared/windows-security-addon'

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
