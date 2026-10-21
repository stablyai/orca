import { readdirSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { sanitizeCrashReportString } from '../../shared/crash-reporting'
import {
  loadWindowsSecurity,
  WINDOWS_FILE_READ_EXECUTE,
  type WindowsSecurity
} from '../../shared/windows-security-addon'

/** ALL RESTRICTED APPLICATION PACKAGES: the grant that cleared electron/electron#51761. */
export const RESTRICTED_APP_PACKAGES_SID = 'S-1-15-2-2'

export type InstallDirPackageGrantOutcome = {
  ok: boolean
  /** Entries whose DACL could not be written (or read, for a directory listing). */
  failedFileCount: number
  reason?: string
}

/**
 * The two passes the repair runs. `root`: one inheritable grant, so files a later update writes
 * inherit it. `tree`: what that grant cannot reach, because a shipped module or directory that
 * carries its own protected DACL inherits nothing from the root.
 */
export type InstallDirPackageGrants = {
  root: (installDir: string) => Promise<InstallDirPackageGrantOutcome>
  tree: (installDir: string) => Promise<InstallDirPackageGrantOutcome>
}

const ADDON_UNAVAILABLE: InstallDirPackageGrantOutcome = {
  ok: false,
  failedFileCount: 0,
  reason: 'addon-unavailable'
}

/** Never `replace`, so SYSTEM, Administrators, the user and the orphan all survive. */
function grantPackageRead(
  security: WindowsSecurity,
  path: string,
  inheritable: boolean
): Promise<void> {
  return security.addon.grantAccessAsync(
    path,
    RESTRICTED_APP_PACKAGES_SID,
    WINDOWS_FILE_READ_EXECUTE,
    {
      inheritable,
      replace: false
    }
  )
}

export async function grantInstallDirPackageRoot(
  installDir: string
): Promise<InstallDirPackageGrantOutcome> {
  const security = loadWindowsSecurity()
  if ('error' in security) {
    return ADDON_UNAVAILABLE
  }
  try {
    await grantPackageRead(security, installDir, true)
    return { ok: true, failedFileCount: 0 }
  } catch (error) {
    return { ok: false, failedFileCount: 1, reason: sanitizeCrashReportString(String(error), 200) }
  }
}

/**
 * Everything below the root (the root pass covers the root), continuing past failures the way
 * `icacls /T /C` did. Every file gets a flagless grant. A directory is granted only when its DACL
 * is protected, and then inheritably so its own descendants inherit it: any other directory
 * already inherits the root's grant, and re-granting it would re-propagate its whole subtree
 * (3.2 s for 1,093 directories in a 7.6k-entry install).
 */
export async function grantInstallDirPackageTree(
  installDir: string
): Promise<InstallDirPackageGrantOutcome> {
  const security = loadWindowsSecurity()
  if ('error' in security) {
    return ADDON_UNAVAILABLE
  }
  let failedFileCount = 0
  let firstFailure: string | undefined
  const attempt = async (step: () => Promise<void> | void): Promise<void> => {
    try {
      await step()
    } catch (error) {
      failedFileCount += 1
      firstFailure ??= sanitizeCrashReportString(String(error), 200)
    }
  }
  const pending = [installDir]
  for (let directory = pending.pop(); directory !== undefined; directory = pending.pop()) {
    const current = directory
    let entries: Dirent[] = []
    await attempt(() => {
      entries = readdirSync(current, { withFileTypes: true })
    })
    for (const entry of entries) {
      const path = join(current, entry.name)
      // Never through a link: a junction can point anywhere, and the repair is for this tree.
      if (entry.isSymbolicLink()) {
        continue
      }
      if (!entry.isDirectory()) {
        await attempt(() => grantPackageRead(security, path, false))
        continue
      }
      pending.push(path)
      await attempt(async () => {
        if (security.addon.getDaclAces(path)?.protected) {
          await grantPackageRead(security, path, true)
        }
      })
    }
  }
  return failedFileCount === 0
    ? { ok: true, failedFileCount: 0 }
    : { ok: false, failedFileCount, reason: `failed-files: ${firstFailure}` }
}

export const installDirPackageGrants: InstallDirPackageGrants = {
  root: grantInstallDirPackageRoot,
  tree: grantInstallDirPackageTree
}
